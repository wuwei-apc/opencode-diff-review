/**
 * Change tracking and revert logic.
 *
 * "Session cumulative" semantics: the first time an AI tool touches a file we
 * store a complete copy of it. Later touches only refresh the "current" side, so
 * a revert always restores the state *before the AI first modified the file*,
 * however many times it edited it afterwards.
 *
 * The tracker holds no in-memory state: everything lives in the file store, so
 * the server process (capture) and the CLI process (panel) see the same data.
 */

import { diffRows, diffText, splitLines, toHunks } from "./diff.ts"
import type { DiffLine } from "./diff.ts"
import { extractPaths, resolveInside, toRelative } from "./paths.ts"
import { ABSENT, readSnapshot, restoreSnapshot, snapshotsEqual } from "./snapshot.ts"
import type { FileSnapshot } from "./snapshot.ts"
import { STORE_VERSION, deleteEntry, listEntries, pruneEntries, readEntry, writeEntry } from "./store.ts"
import type { StoredEntry } from "./store.ts"
import type {
  ChangeScope,
  ChangeStatus,
  ChangeSummary,
  ClearPayload,
  DiffDetailPayload,
  DiffHunkView,
  DiffPayload,
  DiffRowView,
  ListPayload,
  PartialRevertPayload,
  RevertAllPayload,
  RevertPayload,
} from "./types.ts"

/** Directory names that never belong to the AI's own edits. */
const IGNORED_SEGMENTS = new Set(["node_modules", ".git", ".hg", ".svn"])

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Cap on how many hunks the diff browser receives, to bound payload size. */
const MAX_HUNKS = 300

/** Cap on whole-file rows sent for the continuous side-by-side view. */
const MAX_FULL_ROWS = 6000

/** 1-based line numbers for every aligned row. */
function lineNumbersOf(rows: DiffLine[]): Array<{ old: number; new: number }> {
  const result: Array<{ old: number; new: number }> = []
  let oldNumber = 1
  let newNumber = 1

  for (const row of rows) {
    if (row.kind === "context") {
      result.push({ old: oldNumber, new: newNumber })
      oldNumber += 1
      newNumber += 1
    } else if (row.kind === "del") {
      result.push({ old: oldNumber, new: 0 })
      oldNumber += 1
    } else {
      result.push({ old: 0, new: newNumber })
      newNumber += 1
    }
  }

  return result
}

export interface TrackerConfig {
  /** Absolute project directory. Every tracked path stays inside it. */
  root: string
  /** Where entries are persisted; must be identical for both processes. */
  stateDir: string
  maxFileBytes: number
  contextLines: number
  maxLines: number
  /** When non-empty, only these tool names are tracked. */
  trackTools: string[]
  /** Entries untouched for this long are pruned on the next capture. */
  maxAgeMs?: number
}

export interface PreCapture {
  snapshot: FileSnapshot | null
  /** Set when a pre-image existed but could not be stored (e.g. too large). */
  truncated: boolean
  message: string
}

interface Counts {
  additions: number
  deletions: number
  binary: boolean
  approximate: boolean
}

function withTool(tools: string[], tool: string): string[] {
  if (tools.includes(tool)) return tools
  return [...tools, tool].sort()
}

export class ChangeTracker {
  constructor(private readonly config: TrackerConfig) {}

  get root(): string {
    return this.config.root
  }

  get stateDir(): string {
    return this.config.stateDir
  }

  get size(): number {
    return listEntries(this.config.stateDir).length
  }

  /* ---------------------------------------------------------------------- */
  /* Capture                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Files referenced by one tool invocation, as project-relative posix paths.
   * Intentionally permissive: a false positive costs one wasted read, while a
   * false negative loses the ability to revert that file.
   */
  candidatePaths(tool: string, input: unknown): string[] {
    const { trackTools } = this.config
    if (trackTools.length > 0 && !trackTools.includes(tool)) return []

    const result: string[] = []
    const seen = new Set<string>()

    for (const raw of extractPaths(tool, input)) {
      const rel = toRelative(this.config.root, raw.trim())
      if (!rel) continue
      if (this.isIgnored(rel)) continue
      if (seen.has(rel)) continue
      seen.add(rel)
      result.push(rel)
    }

    return result
  }

  /** Snapshot a file before a tool runs. */
  captureBaseline(relPath: string): PreCapture {
    const absolute = this.resolve(relPath)
    if (!absolute) return { snapshot: null, truncated: false, message: "路径越界" }

    const read = readSnapshot(absolute, this.config.maxFileBytes)
    if (read.ok) return { snapshot: read.snapshot, truncated: false, message: "" }

    return {
      snapshot: null,
      truncated: read.reason === "too-large",
      message: read.message,
    }
  }

  /**
   * Record the post-state of a file after a tool ran.
   *
   * Returns true only when a *different* content was stored, so read-only tools
   * leave no trace in the change list.
   */
  recordAfter(args: {
    relPath: string
    tool: string
    sessionID: string
    pre: PreCapture | undefined
  }): boolean {
    const { relPath, tool, sessionID, pre } = args
    const absolute = this.resolve(relPath)
    if (!absolute) return false

    const read = readSnapshot(absolute, this.config.maxFileBytes)
    // `readSnapshot` reports a missing file as `ok` with an absent snapshot, so a
    // failure here means we genuinely cannot see the current state (permissions,
    // directory, oversized). Never guess: a wrong guess could delete a file.
    if (!read.ok) return false

    const current = read.snapshot
    const hasBaseline = pre !== undefined && pre.snapshot !== null
    const baseline = pre?.snapshot ?? ABSENT
    const existing = readEntry(this.config.stateDir, relPath)
    // Strictly increasing, so the panel's optimistic-concurrency token always changes.
    const now = existing ? Math.max(Date.now(), existing.updatedAt + 1) : Date.now()

    // Net-zero change: the file is back to the state it had before the AI first
    // touched it, so there is nothing left to undo or display.
    if (existing && existing.baselineKnown && snapshotsEqual(existing.baseline, current)) {
      deleteEntry(this.config.stateDir, relPath)
      return false
    }

    // This call did not change anything (read-only tool, no-op edit).
    if (hasBaseline && snapshotsEqual(baseline, current)) return false

    // Nothing to restore and nothing to show.
    if (!hasBaseline && !current.exists) return false

    // Line counts are always relative to the revert target, i.e. the *earliest*
    // baseline we know about.
    const countBaseline = existing?.baselineKnown
      ? existing.baseline
      : hasBaseline
        ? baseline
        : ABSENT
    const counts = this.countsFor(countBaseline, current)

    let next: StoredEntry
    if (existing) {
      next = {
        ...existing,
        latest: current,
        touches: existing.touches + 1,
        tools: withTool(existing.tools, tool),
        updatedAt: now,
        ...counts,
      }
      // A later capture with a real pre-image is better than "unknown".
      if (!existing.baselineKnown && hasBaseline) {
        next.baseline = baseline
        next.baselineKnown = true
        next.baselineTruncated = false
        next.baselineMessage = ""
      }
    } else {
      next = {
        version: STORE_VERSION,
        relPath,
        sessionID: sessionID ?? "",
        baseline,
        baselineKnown: hasBaseline,
        baselineTruncated: pre !== undefined && pre.truncated && pre.snapshot === null,
        baselineMessage: pre?.message ?? "未捕获到修改前内容",
        latest: current,
        touches: 1,
        tools: [tool],
        ...counts,
        firstSeenAt: now,
        updatedAt: now,
      }
    }

    writeEntry(this.config.stateDir, next)
    this.prune()
    return true
  }

  /** Drop entries that have not been touched for a while. */
  prune(): void {
    pruneEntries(this.config.stateDir, this.config.maxAgeMs ?? DEFAULT_MAX_AGE_MS)
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  listPayload(scope: ChangeScope, sessionID: string): ListPayload {
    return {
      root: this.config.root,
      entries: this.selected(scope, sessionID).map((entry) => this.summaryOf(entry)),
      generatedAt: Date.now(),
    }
  }

  diffPayload(relPath: string, contextLines?: number, maxLines?: number): DiffPayload {
    const key = this.keyFor(relPath)
    const entry = key ? readEntry(this.config.stateDir, key) : null

    if (!key || !entry) {
      return {
        path: this.resolve(relPath) ?? relPath,
        relPath,
        status: "unknown",
        unified: "",
        additions: 0,
        deletions: 0,
        truncated: false,
        approximate: false,
        binary: false,
        revertable: false,
        message: "该文件不在追踪列表中",
      }
    }

    const revertMessage = this.revertReason(entry)
    const base = {
      path: this.resolve(key) ?? key,
      relPath: key,
      status: this.statusOf(entry),
      revertable: revertMessage === "",
    }

    const binary =
      (entry.baseline.exists && entry.baseline.binary) ||
      (entry.latest.exists && entry.latest.binary)

    if (binary) {
      return {
        path: base.path,
        relPath: base.relPath,
        status: base.status,
        unified: "",
        additions: 0,
        deletions: 0,
        truncated: false,
        approximate: false,
        binary: true,
        revertable: base.revertable,
        message: revertMessage || "二进制文件，无法以文本形式预览",
      }
    }

    const result = diffText(
      entry.baseline.exists ? entry.baseline.content : null,
      entry.latest.exists ? entry.latest.content : null,
      {
        contextLines: contextLines ?? this.config.contextLines,
        maxLines: maxLines ?? this.config.maxLines,
        label: key,
      },
    )

    return {
      path: base.path,
      relPath: base.relPath,
      status: base.status,
      unified: result.unified,
      additions: result.additions,
      deletions: result.deletions,
      truncated: result.truncated,
      approximate: result.approximate,
      binary: false,
      revertable: base.revertable,
      message:
        revertMessage ||
        (result.approximate
          ? "改动过大，已按整体替换展示"
          : result.hunks.length === 0
            ? "内容无差异"
            : ""),
    }
  }

  /** Full hunk/line breakdown used by the diff browser and by line-level revert. */
  diffDetailPayload(relPath: string): DiffDetailPayload {
    const key = this.keyFor(relPath)
    const entry = key ? readEntry(this.config.stateDir, key) : null

    if (!key || !entry) {
      return {
        path: this.resolve(relPath) ?? relPath,
        relPath,
        status: "unknown",
        revertable: false,
        partialRevertable: false,
        binary: false,
        approximate: false,
        truncated: false,
        additions: 0,
        deletions: 0,
        updatedAt: 0,
        message: "该文件不在追踪列表中",
        hunks: [],
        allRows: [],
        totalRows: 0,
      }
    }

    const revertMessage = this.revertReason(entry)
    const revertable = revertMessage === ""
    const binary =
      (entry.baseline.exists && entry.baseline.binary) ||
      (entry.latest.exists && entry.latest.binary)

    const base = {
      path: this.resolve(key) ?? key,
      relPath: key,
      status: this.statusOf(entry),
      revertable,
      partialRevertable: false,
      binary,
      approximate: false,
      truncated: false,
      additions: entry.additions,
      deletions: entry.deletions,
      updatedAt: entry.updatedAt,
      hunks: [] as DiffHunkView[],
      allRows: [] as DiffRowView[],
      totalRows: 0,
    }

    if (binary) {
      return { ...base, message: revertMessage || "二进制文件，无法按行预览" }
    }
    if (!entry.latest.exists) {
      return { ...base, message: "文件已被删除，只能整文件撤回" }
    }

    const beforeText = entry.baseline.exists ? entry.baseline.content : ""
    const afterText = entry.latest.content
    const { rows, approximate } = diffRows(splitLines(beforeText), splitLines(afterText))
    const numbers = lineNumbersOf(rows)
    const hunks = toHunks(rows, this.config.contextLines)
    const truncated = hunks.length > MAX_HUNKS

    const views: DiffHunkView[] = hunks.slice(0, MAX_HUNKS).map((hunk, index) => ({
      index,
      header: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      additions: hunk.lines.filter((line) => line.kind === "add").length,
      deletions: hunk.lines.filter((line) => line.kind === "del").length,
      rows: hunk.lines.map((line, offset) => {
        const rowIndex = hunk.rowStart + offset
        const position = numbers[rowIndex] ?? { old: 0, new: 0 }
        return {
          rowIndex,
          kind: line.kind,
          text: line.text,
          lineNo: line.kind === "del" ? position.old : position.new,
          oldLine: position.old,
          newLine: position.new,
        }
      }),
    }))

    const allRows = rows.map((line, rowIndex) => {
      const position = numbers[rowIndex] ?? { old: 0, new: 0 }
      return {
        rowIndex,
        kind: line.kind,
        text: line.text,
        lineNo: line.kind === "del" ? position.old : position.new,
        oldLine: position.old,
        newLine: position.new,
      }
    })

    return {
      ...base,
      approximate,
      truncated,
      partialRevertable: revertable && !approximate && !truncated,
      hunks: views,
      // Whole-file rows for a continuous side-by-side view, capped so a huge file
      // cannot blow up the payload; `totalRows` tells the viewer what it is missing.
      allRows: allRows.slice(0, MAX_FULL_ROWS),
      totalRows: allRows.length,
      message:
        revertMessage ||
        (approximate
          ? "改动过大，已按整体替换展示，无法按行撤回"
          : views.length === 0
            ? "内容无差异"
            : ""),
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Revert                                                                 */
  /* ---------------------------------------------------------------------- */

  revertPayload(relPath: string): RevertPayload {
    const key = this.keyFor(relPath)
    const entry = key ? readEntry(this.config.stateDir, key) : null
    const absolute = key ? this.resolve(key) : null

    if (!key || !entry || !absolute) {
      return {
        ok: false,
        path: this.resolve(relPath) ?? relPath,
        relPath,
        message: "该文件不在追踪列表中",
      }
    }

    const reason = this.revertReason(entry)
    if (reason) {
      return { ok: false, path: absolute, relPath: key, message: reason }
    }

    // Someone (an editor, a formatter, a shell command) may have touched the file
    // after we recorded it. Restoring is still what the user asked for, but say so.
    const currentRead = readSnapshot(absolute, this.config.maxFileBytes)
    const changedSinceCapture =
      currentRead.ok && !snapshotsEqual(currentRead.snapshot, entry.latest)

    try {
      restoreSnapshot(absolute, entry.baseline)
    } catch (error) {
      return {
        ok: false,
        path: absolute,
        relPath: key,
        message: `写入失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    deleteEntry(this.config.stateDir, key)
    const action = entry.baseline.exists ? "已还原" : "已删除（恢复为修改前不存在）"
    const warning = changedSinceCapture ? "（该文件在追踪后被外部修改过，已一并覆盖）" : ""
    return { ok: true, path: absolute, relPath: key, message: `${action}：${key}${warning}` }
  }

  /**
   * Revert selected diff rows — a whole hunk, or individual lines — and keep the
   * rest of the AI's changes on disk. This is the VS Code / IDEA "revert selected
   * change" behaviour.
   *
   * Reverting a row means: an `add` row is dropped, a `del` row is restored, and
   * unselected rows stay exactly as they are. Selecting every change degrades to a
   * whole-file revert, which then restores the baseline verbatim.
   */
  revertRowsPayload(
    relPath: string,
    rowIndexes: number[],
    expectedUpdatedAt?: number,
  ): PartialRevertPayload {
    const fail = (path: string, rel: string, message: string): PartialRevertPayload => ({
      ok: false,
      path,
      relPath: rel,
      message,
      remaining: 0,
    })

    const key = this.keyFor(relPath)
    const entry = key ? readEntry(this.config.stateDir, key) : null
    const absolute = key ? this.resolve(key) : null
    if (!key || !entry || !absolute) {
      return fail(this.resolve(relPath) ?? relPath, relPath, "该文件不在追踪列表中")
    }

    if (expectedUpdatedAt !== undefined && entry.updatedAt !== expectedUpdatedAt) {
      return fail(absolute, key, "文件在面板打开后又发生了变化，请刷新后重试")
    }

    const reason = this.revertReason(entry)
    if (reason) return fail(absolute, key, reason)

    const binary =
      (entry.baseline.exists && entry.baseline.binary) ||
      (entry.latest.exists && entry.latest.binary)
    if (binary) return fail(absolute, key, "二进制文件不支持按行撤回")
    if (!entry.latest.exists) return fail(absolute, key, "文件已被删除，只能整文件撤回")

    // Row indexes were computed against `entry.latest`. If the file changed on disk
    // since then, applying them would silently clobber those edits.
    const currentRead = readSnapshot(absolute, this.config.maxFileBytes)
    if (!currentRead.ok) return fail(absolute, key, `无法读取当前文件：${currentRead.message}`)
    if (!snapshotsEqual(currentRead.snapshot, entry.latest)) {
      return fail(absolute, key, "文件已被外部修改，请刷新后重试")
    }

    const beforeText = entry.baseline.exists ? entry.baseline.content : ""
    const afterText = entry.latest.content
    const { rows } = diffRows(splitLines(beforeText), splitLines(afterText))
    const selected = new Set(rowIndexes.filter((index) => index >= 0 && index < rows.length))
    if (selected.size === 0) return fail(absolute, key, "没有选中任何改动")

    const allChanged =
      rows.length > 0 &&
      rows.every((row, index) => row.kind === "context" || selected.has(index))

    if (allChanged) {
      // Same result as a whole-file revert, but restore the baseline verbatim so
      // EOL and encoding details cannot drift.
      try {
        restoreSnapshot(absolute, entry.baseline)
      } catch (error) {
        return fail(
          absolute,
          key,
          `写入失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      deleteEntry(this.config.stateDir, key)
      return {
        ok: true,
        path: absolute,
        relPath: key,
        message: "已还原该文件的全部改动",
        remaining: 0,
      }
    }

    // Reverse-apply the selection onto the current content.
    const eol = afterText.includes("\r\n") ? "\r\n" : "\n"
    const trailingNewline = /(?:\r\n|\n)$/.test(afterText)
    const kept: string[] = []

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.kind === "context") {
        kept.push(row.text)
        continue
      }
      if (row.kind === "add") {
        if (!selected.has(index)) kept.push(row.text)
        continue
      }
      // `del`: restore it only when the user asked to revert that line.
      if (selected.has(index)) kept.push(row.text)
    }

    const nextText = kept.length === 0 ? "" : kept.join(eol) + (trailingNewline ? eol : "")
    const nextSnapshot: FileSnapshot = {
      exists: true,
      content: nextText,
      encoding: "utf8",
      size: Buffer.byteLength(nextText, "utf8"),
      binary: false,
    }

    try {
      restoreSnapshot(absolute, nextSnapshot)
    } catch (error) {
      return fail(
        absolute,
        key,
        `写入失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const counts = this.countsFor(entry.baselineKnown ? entry.baseline : ABSENT, nextSnapshot)
    const nextEntry: StoredEntry = {
      ...entry,
      latest: nextSnapshot,
      updatedAt: Math.max(Date.now(), entry.updatedAt + 1),
      ...counts,
    }
    writeEntry(this.config.stateDir, nextEntry)

    const remaining = toHunks(
      diffRows(splitLines(beforeText), splitLines(nextText)).rows,
      this.config.contextLines,
    ).length

    return {
      ok: true,
      path: absolute,
      relPath: key,
      message: `已撤回 ${selected.size} 行，剩余 ${remaining} 处改动`,
      remaining,
    }
  }

  /**
   * Accept (keep) selected rows: the baseline is rebased onto the current content
   * for those rows, so they stop being pending. The file on disk is NOT touched.
   *
   * This is the mirror image of `revertRowsPayload`:
   *   - revert: `add` dropped, `del` restored, written to the file
   *   - accept: `add` adopted, `del` dropped, written to the baseline
   *
   * Accepting everything removes the entry, because nothing is pending anymore —
   * the accepted changes become part of the new reference point.
   */
  acceptRowsPayload(
    relPath: string,
    rowIndexes: number[],
    expectedUpdatedAt?: number,
  ): PartialRevertPayload {
    const fail = (path: string, rel: string, message: string): PartialRevertPayload => ({
      ok: false,
      path,
      relPath: rel,
      message,
      remaining: 0,
    })

    const key = this.keyFor(relPath)
    const entry = key ? readEntry(this.config.stateDir, key) : null
    const absolute = key ? this.resolve(key) : null
    if (!key || !entry || !absolute) {
      return fail(this.resolve(relPath) ?? relPath, relPath, "该文件不在追踪列表中")
    }

    if (expectedUpdatedAt !== undefined && entry.updatedAt !== expectedUpdatedAt) {
      return fail(absolute, key, "文件在面板打开后又发生了变化，请刷新后重试")
    }

    const reason = this.revertReason(entry)
    if (reason) return fail(absolute, key, reason)

    const binary =
      (entry.baseline.exists && entry.baseline.binary) ||
      (entry.latest.exists && entry.latest.binary)
    if (binary) return fail(absolute, key, "二进制文件不支持按块接受")
    if (!entry.latest.exists) return fail(absolute, key, "文件已被删除，只能停止追踪")

    const beforeText = entry.baseline.exists ? entry.baseline.content : ""
    const afterText = entry.latest.content
    const { rows } = diffRows(splitLines(beforeText), splitLines(afterText))
    const selected = new Set(rowIndexes.filter((index) => index >= 0 && index < rows.length))
    if (selected.size === 0) return fail(absolute, key, "没有选中任何改动")

    const allChanged =
      rows.length > 0 &&
      rows.every((row, index) => row.kind === "context" || selected.has(index))

    if (allChanged) {
      deleteEntry(this.config.stateDir, key)
      return {
        ok: true,
        path: absolute,
        relPath: key,
        message: "已接受全部改动，文件内容保持不变",
        remaining: 0,
      }
    }

    const eol = afterText.includes("\r\n") ? "\r\n" : "\n"
    const trailingNewline = /(?:\r\n|\n)$/.test(afterText)
    const kept: string[] = []

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.kind === "context") {
        kept.push(row.text)
        continue
      }
      if (row.kind === "add") {
        // Adopting an added line means the baseline now contains it.
        if (selected.has(index)) kept.push(row.text)
        continue
      }
      // `del`: accepting the deletion removes the line from the baseline.
      if (!selected.has(index)) kept.push(row.text)
    }

    const nextBaselineText = kept.length === 0 ? "" : kept.join(eol) + (trailingNewline ? eol : "")
    const nextBaseline: FileSnapshot =
      entry.baseline.exists || kept.length > 0
        ? {
            exists: true,
            content: nextBaselineText,
            encoding: "utf8",
            size: Buffer.byteLength(nextBaselineText, "utf8"),
            binary: false,
          }
        : ABSENT

    const counts = this.countsFor(nextBaseline, entry.latest)
    const nextEntry: StoredEntry = {
      ...entry,
      baseline: nextBaseline,
      updatedAt: Math.max(Date.now(), entry.updatedAt + 1),
      ...counts,
    }
    writeEntry(this.config.stateDir, nextEntry)

    const remaining = toHunks(
      diffRows(splitLines(nextBaselineText), splitLines(afterText)).rows,
      this.config.contextLines,
    ).length

    return {
      ok: true,
      path: absolute,
      relPath: key,
      message: `已接受 ${selected.size} 行改动，剩余 ${remaining} 处待定`,
      remaining,
    }
  }

  revertAllPayload(scope: ChangeScope, sessionID: string): RevertAllPayload {
    const targets = this.selected(scope, sessionID)
    if (targets.length === 0) {
      return { ok: true, reverted: [], failed: [], message: "没有待撤回的变更" }
    }

    const reverted: string[] = []
    const failed: Array<{ path: string; message: string }> = []

    for (const target of targets) {
      const result = this.revertPayload(target.relPath)
      if (result.ok) reverted.push(result.relPath)
      else failed.push({ path: result.relPath, message: result.message })
    }

    const message =
      failed.length === 0
        ? `已撤回 ${reverted.length} 个文件`
        : `已撤回 ${reverted.length} 个文件，${failed.length} 个未能撤回（基线缺失）`

    return { ok: failed.length === 0, reverted, failed, message }
  }

  /** Stop tracking without touching the working tree. */
  clearPayload(relPath: string, scope: ChangeScope, sessionID: string): ClearPayload {
    if (relPath) {
      const key = this.keyFor(relPath)
      if (key && deleteEntry(this.config.stateDir, key)) {
        return { ok: true, cleared: 1, message: `已停止追踪 ${key}` }
      }
      return { ok: false, cleared: 0, message: "该文件不在追踪列表中" }
    }

    const targets = this.selected(scope, sessionID)
    for (const target of targets) deleteEntry(this.config.stateDir, target.relPath)
    return { ok: true, cleared: targets.length, message: `已清空 ${targets.length} 条追踪记录` }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private resolve(relPath: string): string | null {
    return resolveInside(this.config.root, relPath)
  }

  /** Accept either a project-relative path or an absolute one. */
  private keyFor(candidate: string): string | null {
    if (readEntry(this.config.stateDir, candidate)) return candidate
    const rel = toRelative(this.config.root, candidate)
    if (rel && readEntry(this.config.stateDir, rel)) return rel
    return rel
  }

  private isIgnored(relPath: string): boolean {
    for (const segment of relPath.split("/")) {
      if (IGNORED_SEGMENTS.has(segment)) return true
    }
    return false
  }

  private selected(scope: ChangeScope, sessionID: string): StoredEntry[] {
    const all = listEntries(this.config.stateDir)
    const filtered =
      scope === "session" && sessionID
        ? all.filter((entry) => entry.sessionID === sessionID || entry.sessionID === "")
        : all
    return filtered.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  private statusOf(entry: StoredEntry): ChangeStatus {
    if (!entry.baselineKnown) return "unknown"
    if (!entry.baseline.exists && entry.latest.exists) return "added"
    if (entry.baseline.exists && !entry.latest.exists) return "deleted"
    return "modified"
  }

  private revertReason(entry: StoredEntry): string {
    if (entry.baselineKnown) return ""
    if (entry.baselineTruncated) return "文件超过快照上限，未保存修改前内容，无法撤回"
    return entry.baselineMessage || "未捕获到修改前内容，无法撤回"
  }

  private countsFor(baseline: FileSnapshot, latest: FileSnapshot): Counts {
    const binary =
      (baseline.exists && baseline.binary) || (latest.exists && latest.binary)
    if (binary) return { additions: 0, deletions: 0, binary: true, approximate: false }

    const result = diffText(
      baseline.exists ? baseline.content : null,
      latest.exists ? latest.content : null,
      { contextLines: 0, maxLines: 0 },
    )

    return {
      additions: result.additions,
      deletions: result.deletions,
      binary: false,
      approximate: result.approximate,
    }
  }

  private summaryOf(entry: StoredEntry): ChangeSummary {
    return {
      path: this.resolve(entry.relPath) ?? entry.relPath,
      relPath: entry.relPath,
      status: this.statusOf(entry),
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.binary,
      revertable: this.revertReason(entry) === "",
      truncated: entry.baselineTruncated || entry.approximate,
      touches: entry.touches,
      tools: entry.tools,
      sessionID: entry.sessionID,
      updatedAt: entry.updatedAt,
    }
  }
}
