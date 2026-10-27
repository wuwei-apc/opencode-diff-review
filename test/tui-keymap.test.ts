/**
 * Keymap contract tests for the terminal UI plugin.
 *
 * These guard the regression that made the plugin swallow every `Esc` in the
 * whole TUI. The page keys used to live in a global layer that was always
 * enabled, so the plugin's `escape` binding beat OpenCode's own
 * `session.interrupt`, and its `ctrl+shift+d` beat the built-in
 * `input.delete.line` (delete line in the prompt).
 *
 * Two guarantees are asserted here:
 *   1. the page layer is switched off unless the diff page is open, so the host
 *      never even considers the plugin's bindings;
 *   2. every page command answers `false` when it did not act, which is the
 *      documented way to hand a key back to OpenCode.
 */

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import serverPlugin from "../index.ts"
import tuiPlugin from "../tui.ts"
import type { KeymapCommand, KeymapLayer } from "../src/contracts.ts"

type Setup = (context: unknown) => unknown

interface Navigation {
  type?: string
  name?: string
  sessionID?: string
}

interface Harness {
  layers: KeymapLayer[]
  navigation: Navigation[]
  find(id: string): { layer: KeymapLayer; command: KeymapCommand }
  cleanup(): void
}

/** Every command that lives in the page layer. */
const PAGE_COMMAND_IDS = [
  "opencode.diff.next",
  "opencode.diff.prev",
  "opencode.diff.line.next",
  "opencode.diff.line.prev",
  "opencode.diff.accept",
  "opencode.diff.reject",
  "opencode.diff.scroll.down",
  "opencode.diff.scroll.up",
  "opencode.diff.file.next",
  "opencode.diff.file.prev",
  "opencode.diff.file.accept",
  "opencode.diff.file.reject",
  "opencode.diff.back",
  "opencode.diff.back.esc",
]

/** Resolve a layer's `enabled` the way the host does on every key press. */
function layerEnabled(layer: KeymapLayer): boolean {
  const enabled = layer.enabled
  if (typeof enabled === "function") return enabled()
  return enabled !== false
}

/**
 * A throwaway project with one recorded AI change, plus the TUI plugin wired to
 * a fake host that captures the registered keymap layers and route navigation.
 */
async function harness(): Promise<Harness> {
  const project = mkdtempSync(join(tmpdir(), "diff-review-tui-"))
  const data = mkdtempSync(join(tmpdir(), "diff-review-data-"))
  const previous = process.env.OPENCODE_DATA_DIR
  process.env.OPENCODE_DATA_DIR = data

  // Record one change through the server plugin so the store has an entry.
  const hooks = new Map<string, (event: unknown) => unknown>()
  const serverSetup = (serverPlugin as { setup?: Setup }).setup
  assert.equal(typeof serverSetup, "function", "index.ts must export a plugin with setup()")
  await serverSetup?.call(serverPlugin, {
    location: { directory: project },
    options: {},
    app: { version: "test" },
    tool: {
      hook: async (name: string, callback: (event: unknown) => unknown) => {
        hooks.set(name, callback)
        return {}
      },
    },
  })

  mkdirSync(join(project, "src"), { recursive: true })
  const target = join(project, "src", "app.ts")
  writeFileSync(target, "export const a = 1\n", "utf8")
  const event = { tool: "write", input: { filePath: target }, sessionID: "test" }
  await hooks.get("execute.before")?.(event)
  writeFileSync(target, "export const a = 2\nexport const b = 3\n", "utf8")
  await hooks.get("execute.after")?.(event)

  const layers: KeymapLayer[] = []
  const navigation: Navigation[] = []
  const tuiSetup = (tuiPlugin as { setup?: Setup }).setup
  assert.equal(typeof tuiSetup, "function", "tui.ts must export a plugin with setup()")
  await tuiSetup?.call(tuiPlugin, {
    options: {},
    location: { directory: project },
    app: { version: "test" },
    data: { location: { default: () => ({ directory: project }) } },
    ui: {
      toast: { show: () => {} },
      router: {
        register: () => () => {},
        navigate: (input: Navigation) => {
          navigation.push(input)
        },
        current: () => ({ type: "session", sessionID: "test" }),
      },
    },
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        layers.push(factory())
        return {}
      },
    },
  })

  return {
    layers,
    navigation,
    find(id) {
      for (const layer of layers) {
        const command = layer.commands.find((item) => item.id === id)
        if (command) return { layer, command }
      }
      throw new Error(`command ${id} is not registered`)
    },
    cleanup() {
      if (previous === undefined) delete process.env.OPENCODE_DATA_DIR
      else process.env.OPENCODE_DATA_DIR = previous
      rmSync(project, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    },
  }
}

test("the page keybindings are switched off while the diff page is closed", async () => {
  const h = await harness()
  try {
    const { layer } = h.find("opencode.diff.back.esc")
    assert.equal(
      layerEnabled(layer),
      false,
      "the page layer must be off when no page is open, otherwise the plugin steals Esc",
    )
  } finally {
    h.cleanup()
  }
})

test("every page command hands the key back to the host when it cannot act", async () => {
  const h = await harness()
  try {
    for (const id of PAGE_COMMAND_IDS) {
      const { command } = h.find(id)
      assert.equal(command.run(), false, `${id} must return false so the host keeps the key`)
    }
  } finally {
    h.cleanup()
  }
})

test("the panel toggle stays reachable while the diff page is closed", async () => {
  const h = await harness()
  try {
    const { layer } = h.find("opencode.diff.panel")
    assert.equal(layerEnabled(layer), true, "the panel layer must always be active")
  } finally {
    h.cleanup()
  }
})

test("Esc closes the diff page and is only claimed while the page is open", async () => {
  const h = await harness()
  try {
    const { layer, command } = h.find("opencode.diff.back.esc")
    assert.equal(command.run(), false, "Esc must be handed back while the page is closed")

    // Open the page for real.
    await h.find("opencode.diff.panel").command.run()

    assert.equal(layerEnabled(layer), true, "the page layer must be on while the page is open")
    assert.equal(
      command.run(),
      undefined,
      "Esc must be handled by the plugin while the page is open",
    )
    assert.equal(
      layerEnabled(layer),
      false,
      "the page layer must switch off again once the page is closed",
    )
    assert.ok(
      h.navigation.some((item) => item.type === "session"),
      "leaving the page must navigate back to the session",
    )
  } finally {
    h.cleanup()
  }
})
