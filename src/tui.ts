/**
 * Terminal UI plugin: the IDEA-style review page, and nothing else.
 *
 * There is exactly one surface — the embedded route page (`src/diffview.tsx`).
 * No dialog menu, no second code path: `ctrl+shift+r` / `/diff-review` opens the
 * page, and every decision (block / line / file / all) is made on it.
 *
 * The page is Solid JSX, so it needs `@opentui/solid` at runtime; that package is
 * a real dependency of this plugin (see `package.json`), which is what makes it
 * work from a packaged install as well as from a checked-out tree.
 *
 * Data comes straight from the shared file store, not over RPC: the CLI and the
 * server are separate processes, and a store is a contract we can rely on.
 */

import { resolve } from "node:path"

import { Plugin } from "@opencode/plugin/tui"

import type { TuiPluginContext, TuiToast } from "./contracts.ts"
import type { DiffPageController } from "./diffview.tsx"
import { writeTuiDiagnostics } from "./diagnostics.ts"
import { positiveInteger, readTrackerOptions } from "./options.ts"
import { stateDirFor } from "./store.ts"
import { ChangeTracker } from "./tracker.ts"
import type { ChangeStatus, ChangeSummary } from "./types.ts"

const COMMAND_ID = "opencode.diff.panel"
// `ctrl+shift+d` collides with the built-in `input.delete.line`, so the panel uses
// `ctrl+shift+r` (review): unused by the built-ins and distinct from the page keys.
const DEFAULT_KEYBIND = "ctrl+shift+r"
const DEFAULT_SLASH = "diff-review"

const STATUS_MARK: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  unknown: "?",
}


function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}


function readDefaultLocation(data: unknown): { directory?: string } | undefined {
  try {
    const holder = (data as { location?: { default?: () => { directory?: string } } } | null)?.location
    if (!holder || typeof holder.default !== "function") return undefined
    return holder.default()
  } catch {
    return undefined
  }
}

function resolveProjectRoot(context: TuiPluginContext): string {
  const directory = context.location?.directory ?? readDefaultLocation(context.data)?.directory
  if (typeof directory === "string" && directory.length > 0) return resolve(directory)
  // The CLI is normally launched from the project root, so this stays correct.
  return resolve(process.cwd())
}

export default Plugin.define({
  id: "opencode.diff.tui",

  setup(rawContext: unknown) {
    const context = rawContext as TuiPluginContext
    const options = context.options ?? {}

    const keybind =
      typeof options.keybind === "string" && options.keybind.length > 0
        ? options.keybind
        : DEFAULT_KEYBIND
    const slashName =
      typeof options.slash === "string" && options.slash.length > 0 ? options.slash : DEFAULT_SLASH

    const router = (context.ui as { router?: unknown } | undefined)?.router

    const toast = (input: TuiToast): void => {
      try {
        context.ui?.toast?.show?.(input)
      } catch {
        // A toast failure must never break the panel.
      }
    }

    const root = resolveProjectRoot(context)
    const tracker = new ChangeTracker({
      root,
      stateDir: stateDirFor(root),
      ...readTrackerOptions(options),
    })

    // Startup beacon: proves the CLI-side plugin loaded, and records the project
    // root it resolved (a mismatch with the server root is the classic cause of an
    // apparently empty panel).
    const writeBeacon = (stage: string, extra: Record<string, unknown> = {}): void => {
      writeTuiDiagnostics({
        stage,
        plugin: "opencode.diff.tui",
        root,
        stateDir: stateDirFor(root),
        opencode: context.app?.version ?? "unknown",
        hasRouter: typeof router === "object" && router !== null,
        hasKeymapLayer: typeof context.keymap?.layer === "function",
        hasClientRpc: typeof context.client?.rpc === "function",
        keybind,
        slash: slashName,
        ...extra,
      })
    }
    writeBeacon("setup")

    type Decision = "accept" | "reject"


    let pageController: DiffPageController | null = null
    let pageView: { file: number; hunk: number; line: number; scroll: number } | null = null

    const entriesNow = (): ChangeSummary[] => tracker.listPayload("all", "").entries

    /**
     * The page is loaded on demand so that a *missing* `@opentui/solid` cannot take
     * the whole `tui.ts` entry down at import time (that failure mode is real: a
     * packaged install has no node_modules of its own). It is a declared dependency,
     * so it should always resolve; if it ever does not, the user gets a toast with
     * the exact reason instead of a dead plugin.
     */
    let pageModule: typeof import("./diffview.tsx") | null = null
    let pageModuleLoaded = false

    const loadPageModule = async (): Promise<typeof import("./diffview.tsx") | null> => {
      if (pageModuleLoaded) return pageModule
      pageModuleLoaded = true
      try {
        pageModule = await import("./diffview.tsx")
        return pageModule
      } catch (error) {
        pageModule = null
        console.warn(`[opencode-diff] 双栏页面加载失败：${describe(error)}`)
        return null
      }
    }

    /**
     * The IDEA workspace: a route page that owns browsing AND every operation, so
     * nothing in this flow depends on a dialog.
     */
    const openVisualDiff = async (relPath: string): Promise<void> => {
      const entries = entriesNow()
      if (entries.length === 0) {
        toast({ title: "没有待撤回的 AI 变更", message: root, variant: "info" })
        return
      }

      const mod = await loadPageModule()
      if (!mod) {
        toast({
          title: "双栏页面不可用",
          message: "缺少 @opentui/solid，请重新安装插件（npm install 会带上它）",
          variant: "error",
          duration: 6000,
        })
        return
      }

      if (!pageController) {
        pageController = mod.createDiffPageController(context, {
          list: entriesNow,
          load: (rel) => tracker.diffDetailPayload(rel),
          decide: (kind, rel, rowIndexes, updatedAt) => {
            const result =
              kind === "reject"
                ? tracker.revertRowsPayload(rel, rowIndexes, updatedAt)
                : tracker.acceptRowsPayload(rel, rowIndexes, updatedAt)
            toast({
              title: result.ok ? (kind === "reject" ? "已还原" : "已保留") : "操作失败",
              message: result.message,
              variant: result.ok ? "success" : "error",
              duration: 4000,
            })
            return { ok: result.ok, message: result.message }
          },
          decideAll: (kind) => {
            const result =
              kind === "reject"
                ? tracker.revertAllPayload("all", "")
                : tracker.clearPayload("", "all", "")
            toast({
              title: result.ok ? (kind === "reject" ? "已全部还原" : "已全部保留") : "部分失败",
              message: result.message,
              variant: result.ok ? "success" : "warning",
              duration: 5000,
            })
            return { ok: result.ok, message: result.message }
          },
          fileAction: (kind, relPath) => {
            const result =
              kind === "reject"
                ? tracker.revertPayload(relPath)
                : tracker.clearPayload(relPath, "all", "")
            toast({
              title: result.ok
                ? kind === "reject"
                  ? "已还原该文件"
                  : "已保留该文件"
                : "操作失败",
              message: result.message,
              variant: result.ok ? "success" : "error",
              duration: 4000,
            })
            return { ok: result.ok, message: result.message }
          },
        })
      }

      if (!pageController.available) {
        toast({
          title: "无法打开双栏视图",
          message: "当前构建不提供 ui.router，插件无法内嵌页面",
          variant: "error",
          duration: 6000,
        })
        return
      }

      const index = Math.max(0, entries.findIndex((entry) => entry.relPath === relPath))
      pageView = { file: index, hunk: 0, line: -1, scroll: 0 }
      pageController.open(index, 0, -1)
    }

    const pageShow = (): void => {
      if (!pageView) return
      pageController?.open(pageView.file, pageView.hunk, pageView.scroll)
    }

    /**
     * Scroll the diff viewport. The page renders only a visible window (932 rows of
     * nodes made the renderer miss its frame budget), so scrolling is state-driven.
     */
    const pageScroll = (delta: number): void => {
      if (!pageView) return
      const next = Math.max(0, pageView.scroll + delta)
      if (next === pageView.scroll) return
      pageView.scroll = next
      pageShow()
    }

    const pageMoveHunk = (delta: number): void => {
      if (!pageView) return
      const entries = entriesNow()
      const entry = entries[pageView.file]
      if (!entry) return
      const count = tracker.diffDetailPayload(entry.relPath).hunks.length
      if (count === 0) return
      pageView.hunk = (pageView.hunk + delta + count) % count
      pageView.line = -1
      pageShow()
    }

    const pageMoveLine = (delta: number): void => {
      if (!pageView) return
      const entries = entriesNow()
      const entry = entries[pageView.file]
      if (!entry) return
      const detail = tracker.diffDetailPayload(entry.relPath)
      const hunk = detail.hunks.find((item) => item.index === pageView?.hunk)
      if (!hunk) return
      const count = hunk.rows.filter((row) => row.kind !== "context").length
      if (count === 0) return
      // `line` indexes the block's changed rows, or -1 for "the whole block".
      // Stepping forward from -1 lands on the first row; stepping back wraps to last.
      const from = pageView.line < 0 ? (delta > 0 ? -1 : 0) : pageView.line
      pageView.line = (from + delta + count) % count
      pageShow()
    }

    const pageMoveFile = (delta: number): void => {
      if (!pageView) return
      const entries = entriesNow()
      if (entries.length === 0) return
      pageView.file = (pageView.file + delta + entries.length) % entries.length
      pageView.hunk = 0
      pageView.line = -1
      pageShow()
    }

    const pageDecide = (kind: Decision): void => {
      if (!pageView) return
      const entries = entriesNow()
      const entry = entries[pageView.file]
      if (!entry) return
      const detail = tracker.diffDetailPayload(entry.relPath)
      const hunk = detail.hunks.find((item) => item.index === pageView?.hunk)
      if (!hunk) return

      const changed = hunk.rows.filter((row) => row.kind !== "context")
      const rows =
        pageView.line >= 0 && changed[pageView.line]
          ? [changed[pageView.line].rowIndex]
          : changed.map((row) => row.rowIndex)
      if (rows.length === 0) return

      const result =
        kind === "reject"
          ? tracker.revertRowsPayload(entry.relPath, rows, detail.updatedAt)
          : tracker.acceptRowsPayload(entry.relPath, rows, detail.updatedAt)

      toast({
        title: result.ok ? (kind === "reject" ? "已还原" : "已保留") : "操作失败",
        message: result.message,
        variant: result.ok ? "success" : "error",
        duration: 4000,
      })

      // Clamp and redraw; leaving the page when nothing is pending keeps it honest.
      const remaining = tracker.diffDetailPayload(entry.relPath).hunks.length
      if (remaining === 0) {
        const left = entriesNow().length
        if (left === 0) {
          leavePage()
          return
        }
        pageView.hunk = 0
      } else {
        pageView.hunk = Math.min(pageView.hunk, remaining - 1)
      }
      pageView.line = -1
      pageShow()
    }

    /** Whole-file decision for the file currently selected in the tree. */
    const pageFileAction = (kind: Decision): void => {
      if (!pageView) return
      const entry = entriesNow()[pageView.file]
      if (!entry) return
      if (kind === "reject" && !entry.revertable) {
        toast({
          title: "无法还原",
          message: "没有保存修改前内容（文件过大或被跳过）",
          variant: "warning",
        })
        return
      }

      const result =
        kind === "reject"
          ? tracker.revertPayload(entry.relPath)
          : tracker.clearPayload(entry.relPath, "all", "")

      toast({
        title: result.ok ? (kind === "reject" ? "已还原该文件" : "已保留该文件") : "操作失败",
        message: result.message,
        variant: result.ok ? "success" : "error",
        duration: 4000,
      })

      const left = entriesNow()
      if (left.length === 0) {
        leavePage()
        return
      }
      pageView.file = Math.min(pageView.file, left.length - 1)
      pageView.hunk = 0
      pageView.line = -1
      pageShow()
    }

    const leavePage = (): void => {
      // Never navigate away when no page is open: the back key must be a no-op then.
      if (!pageView && !pageController?.isOpen()) return
      pageController?.back()
      pageView = null
    }

    let busy = false
    const runPanel = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        if (pageView || pageController?.isOpen()) {
          leavePage()
          return
        }

        const entries = entriesNow()
        if (entries.length === 0) {
          toast({ title: "没有待撤回的 AI 变更", message: root, variant: "info" })
          return
        }

        // The page owns every action; the keybinds registered below only drive it.
        const target = entries[0]
        if (target) await openVisualDiff(target.relPath)
      } catch (error) {
        toast({ title: "面板异常", message: describe(error), variant: "error" })
      } finally {
        busy = false
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Keybinding + slash command                                             */
    /* ---------------------------------------------------------------------- */

    const layer = context.keymap?.layer
    if (typeof layer === "function") {
      layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: COMMAND_ID,
            title: "查看 / 撤回 AI 文件变更",
            group: "Diff",
            bind: keybind,
            palette: true,
            suggested: true,
            slash: { name: slashName },
            enabled: () => true,
            run: () => runPanel(),
          },
        ],
        bindings: [COMMAND_ID],
      }))

      // In-page keys. Alt combos cannot be typed as text, so leaving them enabled is
      // safe; each handler still no-ops unless the page is open.
      const pageCommand = (id: string, title: string, bind: string, run: () => void) => ({
        id,
        title,
        group: "Diff 页面",
        bind,
        palette: false,
        enabled: () => true,
        run,
      })

      layer(() => ({
        mode: "global",
        priority: 20,
        commands: [
          pageCommand("opencode.diff.next", "下一处改动", "ctrl+shift+j", () => pageMoveHunk(1)),
          pageCommand("opencode.diff.scroll.down", "向下滚动", "ctrl+shift+d", () =>
            pageScroll(10),
          ),
          pageCommand("opencode.diff.scroll.up", "向上滚动", "ctrl+shift+u", () =>
            pageScroll(-10),
          ),
          pageCommand("opencode.diff.prev", "上一处改动", "ctrl+shift+k", () => pageMoveHunk(-1)),
          pageCommand("opencode.diff.line.next", "下一行改动", "ctrl+shift+n", () => pageMoveLine(1)),
          pageCommand("opencode.diff.line.prev", "上一行改动", "ctrl+shift+m", () => pageMoveLine(-1)),
          pageCommand("opencode.diff.accept", "同意这处改动", "ctrl+shift+f", () => pageDecide("accept")),
          pageCommand("opencode.diff.reject", "不同意这处改动", "ctrl+shift+v", () => pageDecide("reject")),
          pageCommand("opencode.diff.file.next", "下一个文件", "ctrl+shift+o", () => pageMoveFile(1)),
          pageCommand("opencode.diff.file.prev", "上一个文件", "ctrl+shift+p", () => pageMoveFile(-1)),
          pageCommand("opencode.diff.file.accept", "同意整个文件", "ctrl+shift+w", () =>
            pageFileAction("accept"),
          ),
          pageCommand("opencode.diff.file.reject", "不同意整个文件", "ctrl+shift+x", () =>
            pageFileAction("reject"),
          ),
          pageCommand("opencode.diff.back", "返回对话", "ctrl+shift+q", () => leavePage()),
          // Escape as a direct exit: while the diff page is showing it is the most
          // obvious "get me out" key, so it takes precedence over interrupt.
          pageCommand("opencode.diff.back.esc", "退出 diff 页面", "escape", () => leavePage()),
        ],
        bindings: [
          "opencode.diff.next",
          "opencode.diff.prev",
          "opencode.diff.line.next",
          "opencode.diff.line.prev",
          "opencode.diff.accept",
          "opencode.diff.scroll.down",
          "opencode.diff.scroll.up",
          "opencode.diff.reject",
          "opencode.diff.file.next",
          "opencode.diff.file.prev",
          "opencode.diff.file.accept",
          "opencode.diff.file.reject",
          "opencode.diff.back",
          "opencode.diff.back.esc",
        ],
      }))
    } else {
      console.warn("[opencode-diff] 当前 OpenCode 版本不提供 keymap.layer，无法注册快捷键")
    }

    writeBeacon("ready", { keymapRegistered: typeof layer === "function" })
  },
})
