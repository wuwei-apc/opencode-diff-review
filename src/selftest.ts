/**
 * Startup self-test.
 *
 * Runs the whole capture → record → diff → accept → reject pipeline once against
 * a scratch file in the temp directory, then throws it away. Nothing in the user's
 * project is touched.
 *
 * It exists because the engine is the one part that cannot be verified by simply
 * loading the plugin: an import that resolves proves nothing about whether a
 * revert actually restores the right bytes, let alone the right *lines*, and
 * whether "accept" leaves the file alone while rebasing the baseline.
 *
 * Never throws.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ChangeTracker } from "./tracker.ts"

export interface SelfTestStep {
  name: string
  ok: boolean
  detail?: string
}

export interface SelfTestResult {
  ok: boolean
  steps: SelfTestStep[]
}

/** Two changes far enough apart to land in two separate hunks. */
const ORIGINAL = Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n") + "\n"
const MODIFIED = ORIGINAL.replace("l2\n", "L2\n").replace("l11\n", "L11\n")
/** After accepting the l11 hunk: only the l2 change stays pending. */
const ACCEPTED_L11 = ORIGINAL.replace("l11\n", "L11\n")

function makeTracker(root: string): ChangeTracker {
  return new ChangeTracker({
    root,
    stateDir: join(root, ".state"),
    maxFileBytes: 1024 * 1024,
    contextLines: 3,
    maxLines: 400,
    trackTools: [],
  })
}

export function runSelfTest(): SelfTestResult {
  const steps: SelfTestStep[] = []
  let root = ""

  const check = (name: string, ok: boolean, detail?: string): void => {
    steps.push(detail === undefined ? { name, ok } : { name, ok, detail })
  }

  try {
    root = mkdtempSync(join(tmpdir(), "opencode-diff-selftest-"))
    const file = join(root, "sample.txt")
    writeFileSync(file, ORIGINAL, "utf8")

    const tracker = makeTracker(root)

    const pre = tracker.captureBaseline("sample.txt")
    check("captureBaseline", pre.snapshot !== null && pre.snapshot.exists === true)

    writeFileSync(file, MODIFIED, "utf8")
    const recorded = tracker.recordAfter({
      relPath: "sample.txt",
      tool: "edit",
      sessionID: "selftest",
      pre,
    })
    check("recordAfter", recorded === true)

    const entry = tracker.listPayload("all", "").entries[0]
    check(
      "listPayload",
      entry !== undefined &&
        entry.status === "modified" &&
        entry.additions === 2 &&
        entry.deletions === 2,
      entry === undefined ? "列表为空" : `${entry.status} +${entry.additions} -${entry.deletions}`,
    )

    const detail = tracker.diffDetailPayload("sample.txt")
    check(
      "diffDetail",
      detail.hunks.length === 2 && detail.partialRevertable === true,
      `${detail.hunks.length} 个改动块`,
    )

    const changedRows = (payload: typeof detail, hunkIndex: number): number[] => {
      const hunk = payload.hunks.find((item) => item.index === hunkIndex)
      return hunk === undefined
        ? []
        : hunk.rows.filter((row) => row.kind !== "context").map((row) => row.rowIndex)
    }

    // ---- accept the second hunk ------------------------------------------
    const accepted = tracker.acceptRowsPayload(
      "sample.txt",
      changedRows(detail, 1),
      detail.updatedAt,
    )
    check(
      "acceptHunk",
      accepted.ok === true &&
        readFileSync(file, "utf8") === MODIFIED &&
        accepted.remaining === 1,
      accepted.message,
    )

    // ---- stale token must be refused -------------------------------------
    const stale = tracker.revertRowsPayload("sample.txt", [0], detail.updatedAt)
    check("rejectsStaleToken", stale.ok === false, stale.message)

    // ---- reject what is left: the accepted hunk must survive -------------
    const detail2 = tracker.diffDetailPayload("sample.txt")
    const rejected = tracker.revertRowsPayload(
      "sample.txt",
      changedRows(detail2, 0),
      detail2.updatedAt,
    )
    const finalText = readFileSync(file, "utf8")
    check(
      "rejectRest",
      rejected.ok === true && finalText === ACCEPTED_L11,
      rejected.ok ? `剩余 ${rejected.remaining} 处` : rejected.message,
    )

    check("acceptedHunkSurvived", finalText.includes("L11\n") && finalText.includes("l2\n"))
    check("entryRemoved", tracker.listPayload("all", "").entries.length === 0)
    check(
      "rejectsEscape",
      tracker.candidatePaths("write", { filePath: "../escape.txt" }).length === 0,
    )
    check("acceptsInside", tracker.candidatePaths("write", { filePath: "src/a.ts" }).length === 1)
  } catch (error) {
    check("exception", false, error instanceof Error ? error.message : String(error))
  } finally {
    try {
      if (root) rmSync(root, { recursive: true, force: true })
    } catch {
      // A leftover temp dir is harmless.
    }
  }

  return { ok: steps.length > 0 && steps.every((step) => step.ok), steps }
}
