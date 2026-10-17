/**
 * Terminal UI plugin: the "quick view" surface.
 *
 * Everything here is keyboard driven and built from documented primitives
 * (`context.keymap.layer`, `context.ui.dialog`, `context.ui.toast`):
 *
 *   1. A keybinding (or `/diff`) opens the change list.
 *   2. Picking a file opens its actions: view diff / revert this file / stop tracking.
 *   3. "撤回全部" reverts every tracked file in one step.
 *
 * Data comes straight from the shared file store, not over RPC: the CLI and the
 * server are separate processes, and a store is a contract we can rely on.
 */

import { resolve } from "node:path"

import { Plugin } from "@opencode/plugin/tui"

import type {
  DialogOption,
  DialogSelectInput,
  TuiPluginContext,
  TuiToast,
} from "./contracts.ts"
import { createDiffPageController } from "./diffview.tsx"
import { writeTuiDiagnostics } from "./diagnostics.ts"
import { positiveInteger, readTrackerOptions } from "./options.ts"
import { stateDirFor } from "./store.ts"
import { ChangeTracker } from "./tracker.ts"
import type {
  ChangeStatus,
  ChangeSummary,
  DiffDetailPayload,
  DiffHunkView,
  DiffRowView,
  ListPayload,
} from "./types.ts"

const COMMAND_ID = "opencode.diff.panel"
// `ctrl+shift+d` collides with the built-in `input.delete.line`, so the panel uses
// `ctrl+shift+r` (review): unused by the built-ins and distinct from the page keys.
const DEFAULT_KEYBIND = "ctrl+shift+r"
const DEFAULT_SLASH = "diff-review"
const DEFAULT_VIEW_LINES = 400

const STATUS_MARK: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  unknown: "?",
}

const STATUS_LABEL: Record<ChangeStatus, string> = {
  modified: "已修改",
  added: "新增",
  deleted: "已删除",
  unknown: "基线未知",
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function describeEntry(entry: ChangeSummary): string {
  const parts: string[] = []
  if (entry.binary) parts.push("二进制")
  else parts.push(`+${entry.additions} −${entry.deletions}`)
  parts.push(`改 ${entry.touches} 次`)
  if (entry.tools.length > 0) parts.push(entry.tools.join(", "))
  if (!entry.revertable) parts.push("无法撤回")
  return parts.join(" · ")
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
    const confirmRevert = options.confirmRevert !== false
    const viewLines = positiveInteger(options.viewLines, DEFAULT_VIEW_LINES)

    const dialog = context.ui?.dialog

    const toast = (input: TuiToast): void => {
      try {
        context.ui?.toast?.show?.(input)
      } catch {
        // A toast failure must never break the panel.
      }
    }

    if (!dialog?.select) {
      console.warn("[opencode-diff] 当前 OpenCode 版本不提供 dialog.select，变更面板不可用")
      return
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
        hasDialogSelect: typeof dialog?.select === "function",
        hasDialogShow: typeof (dialog as { show?: unknown } | undefined)?.show === "function",
        hasDialogActions: true,
        hasKeymapLayer: typeof context.keymap?.layer === "function",
        hasClientRpc: typeof context.client?.rpc === "function",
        keybind,
        slash: slashName,
        ...extra,
      })
    }
    writeBeacon("setup")

    const select = async (input: DialogSelectInput): Promise<string | undefined> => {
      try {
        return await dialog.select?.(input)
      } catch (error) {
        toast({ title: "面板错误", message: describe(error), variant: "error" })
        return undefined
      }
    }

    const confirm = async (title: string, message: string): Promise<boolean> => {
      if (!confirmRevert) return true
      try {
        return (
          (await dialog.confirm?.({ title, message, label: { confirm: "撤回", cancel: "取消" } })) ===
          true
        )
      } catch {
        return false
      }
    }

    const alert = async (title: string, message: string): Promise<void> => {
      try {
        await dialog.alert?.({ title, message })
      } catch {
        toast({ title, message, variant: "error" })
      }
    }

    /** Run a synchronous store operation, turning failures into a readable alert. */
    const attempt = async <T>(title: string, work: () => T): Promise<T | null> => {
      try {
        return work()
      } catch (error) {
        await alert(title, `${describe(error)}\n\n项目:${root}`)
        return null
      }
    }

    const fetchList = async (): Promise<ListPayload | null> =>
      attempt("读取变更列表失败", () => tracker.listPayload("all", ""))

    let lastEntries: ChangeSummary[] = []

    /* ---------------------------------------------------------------------- */
    /* Diff browser: file -> hunk -> line                                     */
    /* ---------------------------------------------------------------------- */

    const loadDetail = async (relPath: string): Promise<DiffDetailPayload | null> =>
      attempt("读取变更内容失败", () => tracker.diffDetailPayload(relPath))

    const rowLabel = (row: DiffRowView): string => {
      const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "
      const text = row.text.length > 120 ? `${row.text.slice(0, 120)}…` : row.text
      return `${sign} ${String(row.lineNo).padStart(5)}  ${text}`
    }

    const rowCategory = (row: DiffRowView): string =>
      row.kind === "add" ? "新增行（撤回＝删掉这一行）" : "删除行（撤回＝恢复这一行）"

    const hunkLabel = (hunk: DiffHunkView): string =>
      `[${hunk.index + 1}] ${hunk.header}  +${hunk.additions} −${hunk.deletions}`

    const hunkPreview = (hunk: DiffHunkView): string => {
      const changed = hunk.rows.filter((row) => row.kind !== "context")
      const first = changed[0]
      if (!first) return ""
      const suffix = changed.length > 1 ? `（共 ${changed.length} 行改动）` : ""
      return `${first.kind === "add" ? "+" : "−"} ${first.text.slice(0, 80)}${suffix}`
    }

    type Decision = "accept" | "reject"

    const changedRowsOf = (hunk: DiffHunkView): number[] =>
      hunk.rows.filter((row) => row.kind !== "context").map((row) => row.rowIndex)

    /**
     * Apply ✓ (accept) or ✗ (reject) to a set of rows.
     *
     * Accepting rebases the baseline, so the change stops being pending and later
     * "revert all" will not undo it. Rejecting writes the original lines back.
     */
    const applyDecision = async (
      kind: Decision,
      relPath: string,
      rowIndexes: number[],
      updatedAt: number,
    ): Promise<void> => {
      if (rowIndexes.length === 0) return
      const reject = kind === "reject"

      // No confirmation dialog here on purpose: the option label already states the
      // action, and stacking a confirm on top of the list gets clobbered by the next
      // dialog in this build. Destructive whole-file actions still ask separately.

      const result = await attempt(reject ? "撤回失败" : "操作失败", () =>
        reject
          ? tracker.revertRowsPayload(relPath, rowIndexes, updatedAt)
          : tracker.acceptRowsPayload(relPath, rowIndexes, updatedAt),
      )
      if (!result) return

      toast({
        title: result.ok ? (reject ? "已不同意 · 已还原" : "已同意 · 保留") : "操作失败",
        message: result.message,
        variant: result.ok ? "success" : "error",
        duration: 4000,
      })
    }

    const lineMenu = async (
      relPath: string,
      hunk: DiffHunkView,
      detail: DiffDetailPayload,
      kind: Decision,
    ): Promise<void> => {
      const changed = hunk.rows.filter((row) => row.kind !== "context")
      if (changed.length === 0) return

      const shown = changed.slice(0, viewLines)
      const lineOptions: DialogOption[] = shown.map((row) => ({
        title: rowLabel(row),
        value: String(row.rowIndex),
        category: `${rowCategory(row)} · 选中后${kind === "reject" ? "还原" : "接受"}`,
      }))
      if (changed.length > shown.length) {
        lineOptions.push({
          title: `… 还有 ${changed.length - shown.length} 行未显示（可调大 viewLines）`,
          value: "truncated",
          disabled: true,
          category: "提示",
        })
      }

      const choice = await select({
        title:
          kind === "reject"
            ? `逐行不同意 · ${relPath} · 第 ${hunk.index + 1} 处`
            : `逐行同意 · ${relPath} · 第 ${hunk.index + 1} 处`,
        options: lineOptions,
      })
      if (choice === undefined) return

      const rowIndex = Number(choice)
      const row = changed.find((item) => item.rowIndex === rowIndex)
      if (!row) return

      await applyDecision(kind, relPath, [rowIndex], detail.updatedAt)
    }

    const hunkMenu = async (
      relPath: string,
      initial: DiffHunkView,
      detail: DiffDetailPayload,
    ): Promise<void> => {
      for (;;) {
        const hunk = detail.hunks.find((item) => item.index === initial.index) ?? initial
        const changed = hunk.rows.filter((row) => row.kind !== "context")

        const choice = await select({
          title: `${hunkLabel(hunk)} · 第 ${hunk.index + 1} 处`,
          options: [
            {
              title: "→ 同意这处（保留，不再撤回）",
              value: "accept",
              description: "文件内容不变，之后「撤回全部」也不会撤销它",
              disabled: !detail.partialRevertable,
            },
            {
              title: "← 不同意这处（还原为修改前）",
              value: "reject",
              description: `共 ${changed.length} 行改动`,
              disabled: !detail.partialRevertable,
            },
            {
              title: "逐行挑选并同意…",
              value: "lines-accept",
              description: `${changed.length} 行可选`,
              disabled: !detail.partialRevertable,
            },
            {
              title: "逐行挑选并不同意…",
              value: "lines-reject",
              description: `${changed.length} 行可选`,
              disabled: !detail.partialRevertable,
            },
            { title: "查看此块完整 diff", value: "diff" },
            { title: "返回改动列表", value: "back" },
          ],
        })

        if (choice === undefined || choice === "back") return

        if (choice === "diff") {
          await select({
            title: `${relPath} · 第 ${hunk.index + 1} 处`,
            options: hunk.rows.map((row) => ({
              title: rowLabel(row),
              value: String(row.rowIndex),
              category: row.kind === "context" ? "上下文" : rowCategory(row),
            })),
          })
          continue
        }

        if (choice === "accept") {
          await applyDecision("accept", relPath, changed.map((row) => row.rowIndex), detail.updatedAt)
          return
        }

        if (choice === "reject") {
          await applyDecision("reject", relPath, changed.map((row) => row.rowIndex), detail.updatedAt)
          return
        }

        if (choice === "lines-accept") {
          await lineMenu(relPath, hunk, detail, "accept")
          return
        }

        if (choice === "lines-reject") {
          await lineMenu(relPath, hunk, detail, "reject")
          return
        }

        if (choice === "lines") {
          await lineMenu(relPath, hunk, detail, "reject")
          return
        }
      }
    }

    /**
     * Line-by-line diff browser built from dialog options.
     *
     * This host renders dialogs at a fixed, narrow width, so a side-by-side layout
     * wraps and falls apart. A `dialog.select` list sidesteps that entirely: every
     * diff line is one option (single line, truncated by us, never wrapped), the
     * list scrolls, typing filters it, and — crucially — options are the one control
     * this host reliably delivers for both mouse and keyboard.
     *
     * Selecting any line opens that change block's action menu.
     */
    const TEXT_WIDTH = 72

    const diffLinesBrowser = async (
      relPath: string,
      detail: DiffDetailPayload,
    ): Promise<void> => {
      const options: DialogOption[] = []

      for (const hunk of detail.hunks) {
        const group = `@@ -${hunk.oldStart} +${hunk.newStart}　+${hunk.additions} −${hunk.deletions}`
        for (const row of hunk.rows) {
          const sign = row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "
          const number = row.kind === "add" ? row.newLine : row.oldLine
          const text =
            row.text.length > TEXT_WIDTH ? `${row.text.slice(0, TEXT_WIDTH - 1)}…` : row.text
          options.push({
            title: `${sign} ${String(number || "").padStart(4)}  ${text}`,
            value: `row:${hunk.index}`,
            category: group,
          })
        }
      }

      options.push({ title: "↩ 返回改动列表", value: "back", category: "操作" })

      const choice = await select({
        title: `${relPath} · ${detail.hunks.length} 处改动 · 选中任意行后对该块操作`,
        options,
      })
      if (choice === undefined || choice === "back") return

      const hunkIndex = Number(choice.slice("row:".length))
      const hunk = detail.hunks.find((item) => item.index === hunkIndex)
      if (!hunk) return
      await hunkMenu(relPath, hunk, detail)
    }

    /**
     * IDEA-style action list for one file.
     *
     * Every change block exposes its own `→ 同意` / `← 不同意` / `⋮ 逐行` rows, so a
     * decision is one selection away instead of being hidden behind a second menu.
     * These are dialog options on purpose: options are the one interaction this host
     * reliably delivers (clickable AND keyboard selectable), unlike footer actions
     * or arbitrary clickable boxes.
     */
    const browseHunks = async (relPath: string): Promise<void> => {
      let firstPass = true

      for (;;) {
        const detail = await loadDetail(relPath)
        if (!detail) return

        if (detail.binary || detail.hunks.length === 0) {
          if (firstPass) await alert(relPath, detail.message || "没有可显示的差异")
          return
        }
        firstPass = false

        const blocked = !detail.partialRevertable
        const blockedReason = detail.message || "这个文件的改动无法按块处理"

        const optionsList: DialogOption[] = [
          {
            title: "⛶ IDEA 双栏视图（页内操作）",
            value: "action:page",
            description: "全宽左右对照；进入后 alt+j/k 换块、alt+y 同意、alt+x 不同意",
            category: "本文件",
          },
          {
            title: "← 不同意全部（撤回整个文件）",
            value: "action:file-revert",
            description: "还原到 AI 首次修改前",
            category: "本文件",
          },
          {
            title: "→ 同意全部（保留现状，停止追踪）",
            value: "action:file-accept",
            description: "文件内容不变，只是不再出现在列表里",
            category: "本文件",
          },
          { title: "↩ 返回文件列表", value: "action:back", category: "本文件" },
        ]

        for (const hunk of detail.hunks) {
          const group = `改动块 ${hunk.index + 1} · ${hunk.header}`
          const changed = hunk.rows.filter((row) => row.kind !== "context").length

          optionsList.push({
            title: "→ 同意这处",
            value: `accept:${hunk.index}`,
            description: `保留 AI 的改动；之后「撤回全部」也不再撤销它 · ${hunkPreview(hunk)}`,
            category: group,
          })
          optionsList.push({
            title: "← 不同意这处",
            value: `reject:${hunk.index}`,
            description: blocked
              ? blockedReason
              : `还原为修改前，共 ${hunk.additions + hunk.deletions} 行；其他改动保留`,
            category: group,
            disabled: blocked,
          })
          optionsList.push({
            title: "⋮ 逐行处理…",
            value: `lines:${hunk.index}`,
            description: `${changed} 行可单独同意 / 不同意`,
            category: group,
            disabled: blocked,
          })
        }

        const choice = await select({
          title: `${relPath} · ${detail.hunks.length} 处改动  +${detail.additions} −${detail.deletions}`,
          options: optionsList,
        })

        if (choice === undefined || choice === "action:back") return

        if (choice === "action:page") {
          await openVisualDiff(relPath)
          return
        }

        if (choice === "action:file-accept") {
          const result = await attempt("操作失败", () => tracker.clearPayload(relPath, "all", ""))
          if (result) {
            toast({
              title: result.ok ? "已同意全部改动" : "操作失败",
              message: result.message,
              variant: result.ok ? "success" : "error",
              duration: 4000,
            })
          }
          return
        }

        if (choice === "action:file-revert") {
          await revertOne(relPath)
          return
        }

        const separator = choice.indexOf(":")
        if (separator < 0) continue
        const action = choice.slice(0, separator)
        const index = Number(choice.slice(separator + 1))
        const hunk = detail.hunks.find((item) => item.index === index)
        if (!hunk) continue

        if (action === "accept") {
          await applyDecision("accept", relPath, changedRowsOf(hunk), detail.updatedAt)
          continue
        }
        if (action === "reject") {
          await applyDecision("reject", relPath, changedRowsOf(hunk), detail.updatedAt)
          continue
        }
        if (action === "lines") {
          await hunkMenu(relPath, hunk, detail)
          continue
        }
      }
    }

    const revertOne = async (relPath: string): Promise<void> => {
      const entry = lastEntries.find((item) => item.relPath === relPath)
      if (entry && !entry.revertable) {
        toast({
          title: "无法撤回",
          message: "没有保存修改前的内容（文件过大或被跳过）",
          variant: "warning",
        })
        return
      }

      const agreed = await confirm(
        "撤回此文件",
        `将 ${relPath} 恢复到 AI 首次修改前的内容，当前内容会被覆盖。`,
      )
      if (!agreed) return

      const result = await attempt("撤回失败", () => tracker.revertPayload(relPath))
      if (!result) return
      toast({
        title: result.ok ? "已撤回" : "撤回失败",
        message: result.message,
        variant: result.ok ? "success" : "error",
      })
    }

    const forgetOne = async (relPath: string): Promise<void> => {
      const result = await attempt("操作失败", () => tracker.clearPayload(relPath, "all", ""))
      if (!result) return
      toast({
        title: result.ok ? "已停止追踪" : "操作失败",
        message: result.message,
        variant: result.ok ? "info" : "error",
      })
    }

    const revertAll = async (): Promise<void> => {
      const total = lastEntries.length
      const revertableCount = lastEntries.filter((entry) => entry.revertable).length
      if (total === 0) return

      const agreed = await confirm(
        "撤回全部变更",
        `将 ${revertableCount} 个可撤回文件恢复到 AI 首次修改前的内容：\n` +
          lastEntries
            .slice(0, 10)
            .map((entry) => `  ${STATUS_MARK[entry.status]} ${entry.relPath}`)
            .join("\n") +
          (total > 10 ? `\n  … 还有 ${total - 10} 个` : ""),
      )
      if (!agreed) return

      const result = await attempt("撤回失败", () => tracker.revertAllPayload("all", ""))
      if (!result) return

      toast({
        title: result.ok ? "已全部撤回" : "部分撤回",
        message:
          result.failed.length > 0
            ? `${result.message}：\n${result.failed
                .slice(0, 5)
                .map((item) => `  ${item.path}`)
                .join("\n")}`
            : result.message,
        variant: result.ok ? "success" : "warning",
        duration: 5000,
      })
    }

    let pageController: import("./diffview.tsx").DiffPageController | null = null
    let pageView: { file: number; hunk: number; line: number; scroll: number } | null = null

    const entriesNow = (): ChangeSummary[] => tracker.listPayload("all", "").entries

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

      // Static import (top of file) instead of `await import()`: a dynamic import
      // kept diffview.tsx out of the module graph, so editing the page never
      // triggered a reload and every UI change appeared to have no effect.
      if (!pageController) {
        pageController = createDiffPageController(context, {
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
        // Builds without `ui.router` cannot host an embedded page; the dialog flow can.
        await openPanel()
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

    const fileMenu = async (relPath: string): Promise<void> => {
      for (;;) {
        const entry = lastEntries.find((item) => item.relPath === relPath)
        const choice = await select({
          title: `${entry ? STATUS_MARK[entry.status] : "?"} ${relPath}`,
          options: [
            {
              title: "查看改动（按块 / 按行撤回）",
              value: "view",
              description: entry ? describeEntry(entry) : undefined,
            },
            {
              title: "⛶ IDEA 双栏视图（页内操作）",
              value: "page",
              description: "全宽左右对照，进入后用 alt+ 组合键操作",
            },
            {
              title: "撤回此文件",
              value: "revert",
              description: entry?.revertable
                ? "恢复到 AI 首次修改前"
                : "没有保存修改前内容，无法撤回",
              disabled: entry ? !entry.revertable : false,
            },
            {
              title: "停止追踪（不改动文件）",
              value: "forget",
              description: "从列表中移除，保留当前文件内容",
            },
            { title: "返回列表", value: "back" },
          ],
        })

        if (choice === undefined || choice === "back") return
        if (choice === "view") {
          await browseHunks(relPath)
          continue
        }
        if (choice === "page") {
          await openVisualDiff(relPath)
          return
        }
        if (choice === "revert") {
          await revertOne(relPath)
          return
        }
        if (choice === "forget") {
          await forgetOne(relPath)
          return
        }
      }
    }

    const openPanel = async (): Promise<void> => {
      // Only announce an empty list when the panel was opened with nothing to show;
      // after a successful revert the panel should just close quietly.
      let firstPass = true

      for (;;) {
        const payload = await fetchList()
        if (!payload) return

        lastEntries = payload.entries
        if (lastEntries.length === 0) {
          if (firstPass) {
            toast({ title: "没有待撤回的 AI 变更", message: root, variant: "info" })
          }
          return
        }

        firstPass = false

        const revertableCount = lastEntries.filter((entry) => entry.revertable).length
        const optionsList: DialogOption[] = lastEntries.map((entry) => ({
          title: `${STATUS_MARK[entry.status]}  ${entry.relPath}`,
          value: `file:${entry.relPath}`,
          description: describeEntry(entry),
          category: STATUS_LABEL[entry.status],
        }))

        optionsList.push({
          title: "→ 同意全部（保留现状，停止追踪）",
          value: "action:accept-all",
          description: "所有文件内容不变，只是全部从列表移除",
          category: "操作",
        })
        optionsList.push({
          title: `← 不同意全部（可撤回 ${revertableCount} / 共 ${lastEntries.length}）`,
          value: "action:revert-all",
          description: "一次性恢复到 AI 首次修改前",
          category: "操作",
        })
        optionsList.push({
          title: "⟳ 刷新列表",
          value: "action:refresh",
          description: "重新读取追踪状态",
          category: "操作",
        })

        const choice = await select({
          title: `AI 文件变更 · ${lastEntries.length} 个文件`,
          options: optionsList,
        })

        if (choice === undefined) return

        if (choice === "action:refresh") continue
        if (choice === "action:revert-all") {
          await revertAll()
          continue
        }
        if (choice === "action:accept-all") {
          const result = await attempt("操作失败", () => tracker.clearPayload("", "all", ""))
          if (result) {
            toast({
              title: result.ok ? "已同意全部改动" : "操作失败",
              message: result.message,
              variant: result.ok ? "success" : "error",
              duration: 4000,
            })
          }
          continue
        }
        if (choice.startsWith("file:")) {
          await fileMenu(choice.slice("file:".length))
          continue
        }
      }
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

        // No dialogs in this flow. Page operations are driven by cli.json keybinds
        // mapped onto the command ids registered in the layer below — that is the one
        // input path this host actually delivers.
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
