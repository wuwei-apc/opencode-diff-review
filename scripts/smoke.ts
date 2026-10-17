/**
 * Entrypoint smoke test: loads `index.ts` and `tui.ts` the way OpenCode does and
 * drives one capture → diff → revert cycle through the public hook surface.
 *
 *   bun run smoke
 *
 * Kept out of `bun test` on purpose: the unit tests use `node:test` (so they also
 * run under `node --test`), and that shim cannot host async integration tests
 * alongside other files. This script needs no framework — it asserts and exits
 * non-zero on the first failure.
 */

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import serverPlugin from "../index.ts"
import tuiPlugin from "../tui.ts"
import { readTrackerOptions } from "../src/options.ts"
import { stateDirFor } from "../src/store.ts"
import { ChangeTracker } from "../src/tracker.ts"

type Setup = (context: unknown) => unknown

function setupOf(plugin: unknown, label: string): Setup {
  const setup = (plugin as { setup?: Setup } | null)?.setup
  assert.equal(typeof setup, "function", `${label} must export a plugin with setup()`)
  return setup as Setup
}

async function serverCycle(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), "diff-review-project-"))
  const data = mkdtempSync(join(tmpdir(), "diff-review-data-"))
  const previous = process.env.OPENCODE_DATA_DIR
  process.env.OPENCODE_DATA_DIR = data

  try {
    const hooks = new Map<string, (event: unknown) => unknown>()
    const setup = setupOf(serverPlugin, "index.ts")
    const dispose = await setup.call(serverPlugin, {
      location: { directory: project },
      options: {},
      app: { version: "smoke" },
      tool: {
        hook: async (name: string, callback: (event: unknown) => unknown) => {
          hooks.set(name, callback)
          return {}
        },
      },
    })

    assert.ok(hooks.has("execute.before"), "execute.before hook must be registered")
    assert.ok(hooks.has("execute.after"), "execute.after hook must be registered")

    mkdirSync(join(project, "src"), { recursive: true })
    const target = join(project, "src", "app.ts")
    const original = "export const a = 1\nexport const b = 2\n"
    writeFileSync(target, original, "utf8")

    const event = { tool: "write", input: { filePath: target }, sessionID: "smoke" }
    await hooks.get("execute.before")?.(event)
    writeFileSync(target, "export const a = 1\nexport const b = 3\nexport const c = 4\n", "utf8")
    await hooks.get("execute.after")?.(event)

    const tracker = new ChangeTracker({
      root: project,
      stateDir: stateDirFor(project),
      ...readTrackerOptions({}),
    })

    const entries = tracker.listPayload("all", "").entries
    assert.equal(entries.length, 1, "the write must be tracked")
    assert.equal(entries[0]?.relPath, "src/app.ts")
    assert.equal(entries[0]?.status, "modified")
    assert.equal(entries[0]?.additions, 2)
    assert.equal(entries[0]?.deletions, 1)

    const detail = tracker.diffDetailPayload("src/app.ts")
    assert.ok(detail.hunks.length > 0, "the diff must have at least one hunk")
    assert.ok(detail.allRows.length > 0, "the side-by-side view needs allRows")

    const rejected = tracker.revertRowsPayload("src/app.ts", [detail.hunks[0]?.rows.find((row) => row.kind !== "context")?.rowIndex ?? 0], detail.updatedAt)
    assert.ok(typeof rejected.ok === "boolean")

    const reverted = tracker.revertPayload("src/app.ts")
    assert.equal(reverted.ok, true, "a whole-file revert must succeed")
    assert.equal(readFileSync(target, "utf8"), original, "the baseline content must be restored")
    assert.equal(tracker.listPayload("all", "").entries.length, 0)

    if (typeof dispose === "function") await dispose()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DATA_DIR
    else process.env.OPENCODE_DATA_DIR = previous
    rmSync(project, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  }
}

async function tuiWiring(): Promise<void> {
  const layers: Array<Array<{ id: string }>> = []
  const setup = setupOf(tuiPlugin, "tui.ts")
  const dispose = await setup.call(tuiPlugin, {
    options: {},
    location: { directory: process.cwd() },
    app: { version: "smoke" },
    data: { location: { default: () => ({ directory: process.cwd() }) } },
    ui: {
      toast: { show: () => {} },
      dialog: { select: async () => undefined, confirm: async () => true, alert: async () => {} },
      router: {
        register: (input: unknown) => input,
        navigate: () => {},
        current: () => ({ type: "session", sessionID: "smoke" }),
      },
    },
    keymap: {
      layer: (factory: () => { commands: Array<{ id: string }> }) => {
        layers.push(factory().commands)
        return {}
      },
    },
  })

  const ids = new Set(layers.flatMap((commands) => commands.map((command) => command.id)))
  for (const id of [
    "opencode.diff.panel",
    "opencode.diff.next",
    "opencode.diff.prev",
    "opencode.diff.accept",
    "opencode.diff.reject",
    "opencode.diff.scroll.down",
    "opencode.diff.scroll.up",
    "opencode.diff.back.esc",
  ]) {
    assert.ok(ids.has(id), `tui.ts must register the ${id} command`)
  }

  if (typeof dispose === "function") await dispose()
}

await serverCycle()
console.log("ok  index.ts  capture → diff → revert")
await tuiWiring()
console.log("ok  tui.ts    keymap layers")
