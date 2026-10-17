/**
 * IDEA-style diff workspace: one route page that owns the whole review loop.
 *
 * Layout
 *   ┌ [▲][▼] 块 n/m   [同意块][不同意块][同意全部][不同意全部][刷新][返回] ┐
 *   ├ 文件树 + 搜索 ─┬ 整文件双栏对照（全部行，配对对齐） ─────┬ 滚动条 ┤
 *   └ 状态栏 ────────┴────────────────────────────────────────┴────────┘
 *
 * Key decisions, each driven by something this host actually does:
 *   - rows are ONE pre-formatted string each (`marker no left │ no right`): a
 *     multi-column flex matrix drifted, strings cannot.
 *   - the whole file is shown, not hunks: hunks alone leave the page looking like
 *     disconnected fragments with big blank bands.
 *   - deletions and additions are PAIRED per change run (LCS emits del-run then
 *     add-run; rendering them stacked doubled the height and left empty columns).
 *   - scrolling is a rendered window + scrollbar, so it works without a native
 *     scroll container (which misbehaved earlier).
 */

import { createSignal, onCleanup, onMount } from "solid-js"

import type { TuiPluginContext } from "./contracts.ts"
import { NUM, SCROLLBAR, SIDEBAR, gridWidths, panelCell } from "./layout.ts"
import type { PanelState } from "./layout.ts"
import { ICON_COLUMNS, labelWidth, truncateLabel } from "./tree.ts"
import type { ChangeSummary, DiffDetailPayload, DiffRowView } from "./types.ts"

export type Decision = "accept" | "reject"

export interface DiffPageApi {
  list(): ChangeSummary[]
  load(relPath: string): DiffDetailPayload | null
  decide(
    kind: Decision,
    relPath: string,
    rowIndexes: number[],
    updatedAt: number,
  ): { ok: boolean; message: string }
  decideAll(kind: Decision): { ok: boolean; message: string }
  fileAction(kind: Decision, relPath: string): { ok: boolean; message: string }
}

export interface DiffPageData {
  file: number
  /** Index into `blocks` (contiguous change blocks, not hunks). */
  block: number
  filter: string
  collapsed: string[]
  hoverFile: number
  /** First visible row of the paired list. */
  scroll: number
  nonce: number
}

export const ROUTE_NAME = "opencode-diff"

const C = {
  /**
   * Base surface for everything. Without an explicit background the panes fell back
   * to the terminal's own (light) background while the text colours are designed for
   * dark, which is why untinted context rows looked washed out and the page had no
   * consistent depth ordering.
   */
  base: "#0b0f14",
  text: "#d7dae0",
  dim: "#6b7280",
  add: "#7ee787",
  del: "#ff7b72",
  marker: "#e3b341",
  title: "#79c0ff",
  bar: "#1c2128",
  side: "#12171d",
  hunkHead: "#a371f7",
  focusBg: "#1f4b78",
  white: "#ffffff",
  blockBg: "#161c23",
  delBg: "#2a1214",
  addBg: "#0e2a1b",
  thumb: "#8b949e",
  track: "#30363d",
  /** The always-on divider rail: brighter than the panes so it reads as a seam. */
  line: "#6e7681",
  /**
   * Panel band. Must be clearly lighter than `delBg` / `addBg` (#1f1114 / #0f1a14),
   * otherwise the 5-column panel reads as empty space instead of a surface.
   */
  gutter: "#2d333b",
  /** Action cells: one step brighter again, so they look pressable. */
  gutterStrong: "#444c56",
}

/* ------------------------------- metrics -------------------------------- */
/* SIDEBAR / NUM / SCROLLBAR / panel geometry and `panelCell` live in layout.ts,
   which has no JSX and is unit-tested directly. */


function cols(): number {
  const value = (process.stdout as { columns?: number }).columns
  return typeof value === "number" && value > 50 ? value : 150
}

function rowsOf(): number {
  const value = (process.stdout as { rows?: number }).rows
  return typeof value === "number" && value > 16 ? value : 46
}

function fit(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  return `${text.slice(0, width - 1)}…`
}

/* moved to layout.ts */

function num(value: number): string {
  return (value > 0 ? String(value) : "").padStart(NUM)
}

const STATUS_MARK: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  unknown: "?",
}

/* ------------------------------ pairing --------------------------------- */

interface Pair {
  left?: DiffRowView
  right?: DiffRowView
}

/** Pair deletions with additions inside each contiguous change run. */
export function pairRows(rows: DiffRowView[]): Pair[] {
  const out: Pair[] = []
  let index = 0

  while (index < rows.length) {
    const row = rows[index] as DiffRowView
    if (row.kind === "context") {
      out.push({ left: row, right: row })
      index += 1
      continue
    }

    const run: DiffRowView[] = []
    while (index < rows.length && (rows[index] as DiffRowView).kind !== "context") {
      run.push(rows[index] as DiffRowView)
      index += 1
    }

    const dels = run.filter((item) => item.kind === "del")
    const adds = run.filter((item) => item.kind === "add")
    const pairs = Math.max(dels.length, adds.length)
    for (let k = 0; k < pairs; k += 1) out.push({ left: dels[k], right: adds[k] })
  }

  return out
}

interface Block {
  /** Index of the first pair belonging to this block. */
  start: number
  rowIndexes: number[]
  additions: number
  deletions: number
}

/** Contiguous groups of change pairs; each gets its own header and buttons. */
export function buildBlocks(pairs: Pair[]): Block[] {
  const blocks: Block[] = []
  let current: Block | null = null

  pairs.forEach((pair, index) => {
    const changed = (pair.left && pair.left.kind !== "context") || (pair.right && pair.right.kind !== "context")
    if (!changed) {
      current = null
      return
    }
    if (!current) {
      current = { start: index, rowIndexes: [], additions: 0, deletions: 0 }
      blocks.push(current)
    }
    if (pair.left && pair.left.kind === "del") {
      current.rowIndexes.push(pair.left.rowIndex)
      current.deletions += 1
    }
    if (pair.right && pair.right.kind === "add") {
      current.rowIndexes.push(pair.right.rowIndex)
      current.additions += 1
    }
  })

  return blocks
}

/* ------------------------------- scrollbar ------------------------------- */

export function scrollbar(total: number, visible: number, offset: number): { from: number; to: number } {
  if (total <= visible || visible <= 0) return { from: 0, to: Math.max(0, visible - 1) }
  const height = visible
  const size = Math.max(1, Math.round((visible / total) * height))
  const maxOffset = total - visible
  const ratio = maxOffset <= 0 ? 0 : Math.min(1, Math.max(0, offset / maxOffset))
  const from = Math.round(ratio * (height - size))
  return { from, to: from + size - 1 }
}

/* ------------------------------ file tree ------------------------------- */

interface TreeRow {
  kind: "dir" | "file"
  label: string
  depth: number
  file?: number
  dir?: string
  active: boolean
}

function buildTree(files: ChangeSummary[], collapsed: string[], cursor: number): TreeRow[] {
  const rows: TreeRow[] = []
  const emitted = new Set<string>()

  files.forEach((file, index) => {
    const parts = file.relPath.split("/")
    let prefix = ""
    let hidden = false

    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const segment = parts[depth] as string
      prefix = prefix ? `${prefix}/${segment}` : segment
      if (hidden) continue
      if (!emitted.has(prefix)) {
        emitted.add(prefix)
        const isCollapsed = collapsed.includes(prefix)
        rows.push({
          kind: "dir",
          label: `${isCollapsed ? "▸" : "▾"} ${segment}/`,
          depth,
          dir: prefix,
          active: false,
        })
        if (isCollapsed) hidden = true
      }
      if (collapsed.includes(prefix)) hidden = true
    }

    if (hidden) return
    rows.push({
      kind: "file",
      label: `${STATUS_MARK[file.status] ?? "?"} ${parts[parts.length - 1] ?? file.relPath}`,
      depth: parts.length - 1,
      file: index,
      active: index === cursor,
    })
  })

  return rows
}

/* -------------------------------- page ---------------------------------- */

/**
 * Memoised diff payloads. `api.load` performs synchronous disk reads plus a
 * whole-file LCS diff; doing that on every render is what makes the page hitch.
 * Invalidated whenever the action nonce changes (i.e. after accept/reject/refresh).
 */
const detailCache = new Map<string, DiffDetailPayload | null>()
let cacheNonce = -1

interface PageProps {
  data: DiffPageData
  api: DiffPageApi
  navigate: (data: Partial<DiffPageData>) => void
  close: () => void
}

function DiffPage(props: PageProps) {
  const total = cols()
  /*
   * Height budget, computed top-down and hard-locked at every level.
   *
   * Root cause of the constant flicker: the page rendered more rows than the
   * terminal has, so the renderer alternated between clipping and scrolling every
   * frame. Nothing inside the page may be allowed to exceed `rootHeight`.
   *
   *   rootHeight = rows - 1                (one spare line)
   *   mainHeight = rootHeight - 2          (top action bar + status bar)
   *   treeHeight = mainHeight - 3          (tree header + separator + search row)
   *   diffBody   = mainHeight - 2          (file header + column header)
   */
  const rootHeight = Math.max(10, rowsOf() - 1)
  // Two spacer rows (under the toolbar, above the status bar) give the sections
  // visible breathing room: hierarchy from spacing, not just colour.
  const mainHeight = Math.max(8, rootHeight - 4)
  const treeHeight = Math.max(2, mainHeight - 2)
  const diffBodyHeight = Math.max(4, mainHeight - 2)
  const w = gridWidths(total)
  const pane = w.pane
  const gutter = total - w.sidebar - w.scroll

  const all = props.api.list()

  // Empty state: with nothing tracked the full chrome is just a black void, so show
  // one clear message instead of an empty two-pane skeleton.
  if (all.length === 0) {
    return (
      <box
        flexDirection="column"
        height={rootHeight}
        flexGrow={0}
        flexShrink={0}
        backgroundColor={C.base}
        justifyContent="center"
        alignItems="center"
      >
        <text fg={C.title}>{"没有待撤回的 AI 变更"}</text>
        <text fg={C.dim}>{"AI 修改文件后会自动出现在这里"}</text>
        <text fg={C.marker}>{"Esc 返回对话"}</text>
      </box>
    )
  }
  const needle = props.data.filter.trim().toLowerCase()
  const files = needle ? all.filter((file) => file.relPath.toLowerCase().includes(needle)) : all
  const fileIndex = Math.min(Math.max(0, props.data.file), Math.max(0, files.length - 1))
  const file = files[fileIndex]
  if (cacheNonce !== props.data.nonce) {
    detailCache.clear()
    cacheNonce = props.data.nonce
  }
  const cached = file ? detailCache.get(file.relPath) : undefined
  const detail = !file
    ? null
    : cached !== undefined
      ? cached
      : (() => {
          const value = props.api.load(file.relPath)
          detailCache.set(file.relPath, value)
          return value
        })()
  const allRows = detail?.allRows ?? []
  const pairs = pairRows(allRows)
  const blocks = buildBlocks(pairs)

  // Map every pair index to the block that CONTAINS it. Looking up
  // `blocks.find(b => b.start === index)` only ever matched a block's first row,
  // so the reject arrow (`ordinal === 1`) was never rendered.
  const blockAt: number[] = new Array(pairs.length).fill(-1)
  blocks.forEach((item, bi) => {
    const end = (blocks[bi + 1]?.start ?? pairs.length) - 1
    for (let i = item.start; i <= end && i < pairs.length; i += 1) blockAt[i] = bi
  })
  const blockIndex = Math.min(Math.max(0, props.data.block), Math.max(0, blocks.length - 1))
  const block = blocks[blockIndex]

  const maxScroll = Math.max(0, pairs.length - diffBodyHeight)
  const scroll = Math.min(Math.max(0, props.data.scroll), maxScroll)

  const decide = (kind: Decision, target: Block | undefined): void => {
    if (!detail || !file || !target || target.rowIndexes.length === 0) return
    props.api.decide(kind, file.relPath, target.rowIndexes, detail.updatedAt)
    props.navigate({ scroll: props.data.scroll, nonce: props.data.nonce + 1 })
  }

  const decideAll = (kind: Decision): void => {
    props.api.decideAll(kind)
    props.navigate({ block: 0, scroll: 0, nonce: props.data.nonce + 1 })
  }

  const fileAct = (kind: Decision, index: number): void => {
    const target = files[index]
    if (!target) return
    if (kind === "reject" && !target.revertable) return
    props.api.fileAction(kind, target.relPath)
    props.navigate({ file: Math.min(index, Math.max(0, props.api.list().length - 1)), block: 0, scroll: 0, hoverFile: -1, nonce: props.data.nonce + 1 })
  }

  /**
   * Mouse wheel scrolling. The native scroll container was removed (it painted all
   * 932 rows every frame), so the wheel event is handled here and turned into the
   * same state change the keyboard uses. The event shape differs between builds, so
   * the delta is read defensively.
   */
  const wheel = (event: unknown, rows: number): void => {
    const raw = event as
      | {
          scroll?: { deltaY?: number; delta?: number; direction?: string }
          deltaY?: number
          delta?: number
          direction?: string
        }
      | undefined

    const detail = raw?.scroll
    const delta = detail?.deltaY ?? detail?.delta ?? raw?.deltaY ?? raw?.delta ?? 0
    const direction = detail?.direction ?? raw?.direction

    // OpenTUI reports the wheel as a direction plus a (usually positive) magnitude,
    // so reading only `delta` made every event look like "scroll down".
    const sign =
      direction === "up" || direction === "left"
        ? -1
        : direction === "down" || direction === "right"
          ? 1
          : delta > 0
            ? 1
            : delta < 0
              ? -1
              : 0
    if (sign === 0) return

    const step = sign > 0 ? 3 : -3
    const next = Math.min(Math.max(0, scroll + step), Math.max(0, pairs.length - rows))
    if (next !== scroll) props.navigate({ scroll: next })
  }

  /** Jump to a block and scroll it into view. */
  const goBlock = (index: number): void => {    if (blocks.length === 0) return
    const next = (index + blocks.length) % blocks.length
    const target = blocks[next]
    props.navigate({
      block: next,
      scroll: target ? Math.max(0, Math.min(target.start - 1, maxScroll)) : 0,
      nonce: props.data.nonce + 1,
    })
  }

  /* ---- assemble the visible list: block headers interleaved with pairs ---- */
  type Line = {
    left: string
    /** Middle panel cell state: the seam doubles as the block action surface. */
    panel: PanelState
    right: string
    fg: string
    bg?: string
    headerIndex?: number
    blockIndex?: number
  }
  const lines: Line[] = []
  const headers = new Map<number, number>()

  blocks.forEach((item, index) => headers.set(item.start, index))

  pairs.forEach((pair, index) => {
    const headerIndex = headers.get(index)
    if (typeof headerIndex === "number") {
      const item = blocks[headerIndex] as Block
      const current = headerIndex === blockIndex
      const stats = `+${item.additions} −${item.deletions} · ${item.rowIndexes.length} 行`
      // A blank separator before every block after the first: hierarchy comes from
      // spacing, so the block header reads as a section title rather than another
      // diff row glued to the previous block.
      if (headerIndex > 0) {
        lines.push({ left: "", panel: "rail", right: "", fg: C.dim })
      }
      lines.push({
        left: fit(`${current ? "▶" : " "} ── 改动块 ${headerIndex + 1}/${blocks.length}   ${stats}`, gutter),
        panel: "rail",
        right: "",
        fg: C.hunkHead,
        bg: current ? C.focusBg : C.blockBg,
        headerIndex,
      })
    }

    const left = pair.left
    const right = pair.right
    const leftNo = left ? num(left.oldLine) : " ".repeat(NUM)
    const rightNo = right ? num(right.newLine) : " ".repeat(NUM)
    const leftText = fit(left ? left.text : "", pane).padEnd(pane)
    const rightText = fit(right ? right.text : "", pane)
    const leftSign = left ? (left.kind === "del" ? "−" : " ") : " "
    const rightSign = right ? (right.kind === "add" ? "+" : " ") : " "

    const owner = blockAt[index] ?? -1
    const ordinal = owner >= 0 ? index - (blocks[owner] as Block).start : -1

    lines.push({
      left: ` ${leftSign}${leftNo} ${leftText}`,
      // The panel is the action surface: a block's first two rows host the accept
      // and reject cells, every other row keeps the rail.
      panel: ordinal === 0 ? "accept" : ordinal === 1 ? "reject" : "rail",
      right: `${rightSign}${rightNo} ${rightText}`,
      fg: left?.kind === "del" ? C.del : right?.kind === "add" ? C.add : C.text,
      // Context rows get the base surface too: leaving them transparent made the
      // light terminal background bleed through and broke the depth ordering.
      bg:
        left?.kind === "del"
          ? C.delBg
          : right?.kind === "add"
            ? C.addBg
            : C.base,
      blockIndex: owner >= 0 ? owner : undefined,
    })
  })

  const tree = buildTree(files, props.data.collapsed, fileIndex)

  /*
   * Inline search state. Typing stays local (the input owns the caret) and committing
   * the filter is debounced: each commit rebuilds the visible window, so one route
   * render per keystroke would be wasteful.
   */
  const [query, setQuery] = createSignal(props.data.filter)

  /*
   * Watch for files appearing or disappearing. The page reads the tracker once per
   * render, so without this a file the AI creates while the page is open never shows
   * up (and a cleared list keeps showing the old contents). Polling is cheap: it only
   * compares a handful of strings and re-navigates when the set actually changes.
   */
  onMount(() => {
    const signature = (): string =>
      props.api
        .list()
        .map((entry) => `${entry.relPath}:${entry.updatedAt}`)
        .join(",")
    let seen = signature()
    const timer = setInterval(() => {
      const next = signature()
      if (next === seen) return
      seen = next
      props.navigate({ nonce: props.data.nonce + 1 })
    }, 1500)
    onCleanup(() => clearInterval(timer))
  })
  let debounce: ReturnType<typeof setTimeout> | undefined
  const commitFilter = (value: string): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (value === props.data.filter) return
      props.navigate({
        filter: value,
        file: 0,
        block: 0,
        scroll: 0,
        nonce: props.data.nonce + 1,
      })
    }, 180)
  }

  return (
    <box flexDirection="column" height={rootHeight} flexGrow={0} flexShrink={0} backgroundColor={C.base}>
      {/* ---------------- top actions ---------------- */}
      {/* A fixed height + flexShrink:0 stops the bar from collapsing when the flex
          layout is tight, which is what made the buttons disappear. */}
      <box
        flexDirection="row"
        flexGrow={0}
        flexShrink={0}
        height={1}
        minHeight={1}
        backgroundColor={C.bar}
      >
        <text fg={C.title} onMouseDown={() => goBlock(blockIndex - 1)}>
          {" ▲ "}
        </text>
        <text fg={C.title} onMouseDown={() => goBlock(blockIndex + 1)}>
          {" ▼ "}
        </text>
        <text fg={C.dim}>{fit(` 块 ${blocks.length === 0 ? 0 : blockIndex + 1}/${blocks.length} `, 10)}</text>
        <text fg={C.add} onMouseDown={() => decide("accept", block)}>
          {"✓同意块 "}
        </text>
        <text fg={C.del} onMouseDown={() => decide("reject", block)}>
          {"✗不同意块 "}
        </text>
        <text fg={C.dim}>{"│ "}</text>
        <text fg={C.add} onMouseDown={() => decideAll("accept")}>
          {"✓同意全部 "}
        </text>
        <text fg={C.del} onMouseDown={() => decideAll("reject")}>
          {"✗不同意全部 "}
        </text>
        <text fg={C.dim}>{"│ "}</text>
        <text
          fg={C.title}
          onMouseDown={() => props.navigate({ scroll: 0, nonce: props.data.nonce + 1 })}
        >
          {"⟳刷新 "}
        </text>
        <text fg={C.white} onMouseDown={() => props.close()}>
          {"⏻退出(Esc)"}
        </text>
      </box>

      {/* Spacer: separates the toolbar from the content below it. */}
      <box flexDirection="row" height={1} flexShrink={0} backgroundColor={C.bar}>
        <text fg={C.dim}>{" "}</text>
      </box>

      <box flexDirection="row" height={mainHeight} flexGrow={0} flexShrink={0}>
        {/* ---------------- file tree ---------------- */}
        <box flexDirection="column" width={SIDEBAR} height={mainHeight} flexGrow={0} flexShrink={0} backgroundColor={C.side}>
          {/* Tree header: the count is the hierarchy anchor for the region. */}
          <box flexDirection="row" height={1} flexShrink={0} backgroundColor={C.bar}>
            <text fg={C.dim}>{fit(` 文件 ${files.length}`, SIDEBAR)}</text>
          </box>

          {/* Inline search input, framed and width-locked to the sidebar. Without the
              frame and the explicit width the input renderable sized itself to its
              content and drifted out of the tree column. */}
          <box
            flexDirection="row"
            width={SIDEBAR}
            height={1}
            flexShrink={0}
            backgroundColor={C.gutter}
          >
            <text fg={C.line}>{"│"}</text>
            <input
              width={SIDEBAR - 2}
              value={query()}
              focused
              placeholder="搜索"
              onInput={(value: unknown) => {
                const text =
                  typeof value === "string"
                    ? value
                    : typeof (value as { value?: unknown })?.value === "string"
                      ? String((value as { value: string }).value)
                      : query()
                setQuery(text)
                commitFilter(text.trim())
              }}
            />
            <text fg={C.line}>{"│"}</text>
          </box>

          {tree.slice(0, treeHeight).map((row) => {
            const isFile = row.kind === "file" && typeof row.file === "number"
            const index = isFile ? (row.file as number) : -1
            const entry = isFile ? files[index] : undefined
            const hot = isFile && props.data.hoverFile === index
            const nameWidth = Math.max(4, labelWidth(SIDEBAR) - row.depth * 2)
            // "M todo.html" → marker + name, so the status can get its own colour.
            const space = row.label.indexOf(" ")
            const mark = space > 0 ? row.label.slice(0, space) : ""
            const name = space > 0 ? row.label.slice(space + 1) : row.label
            const markColor =
              mark === "A" ? C.add : mark === "D" ? C.del : mark === "M" ? C.marker : C.dim

            return (
              <box
                flexDirection="row"
                height={1}
                flexShrink={0}
                backgroundColor={row.active ? C.focusBg : undefined}
                onMouseDown={() => {
                  if (isFile) {
                    props.navigate({ file: index, block: 0, scroll: 0 })
                    return
                  }
                  if (row.dir) {
                    const has = props.data.collapsed.includes(row.dir)
                    props.navigate({
                      collapsed: has
                        ? props.data.collapsed.filter((item) => item !== row.dir)
                        : [...props.data.collapsed, row.dir],
                    })
                  }
                }}
              >
                <box flexDirection="row" width={labelWidth(SIDEBAR)} height={1} flexShrink={0}>
                  {isFile ? (
                    <>
                      <text fg={row.active ? C.white : markColor}>{` ${"  ".repeat(row.depth)}${mark}`}</text>
                      <text fg={row.active ? C.white : C.text}>
                        {fit(` ${truncateLabel(name, nameWidth - 2)}`, Math.max(1, nameWidth - 1))}
                      </text>
                    </>
                  ) : (
                    <text fg={row.kind === "dir" ? C.title : C.text}>
                      {fit(` ${"  ".repeat(row.depth)}${truncateLabel(row.label, nameWidth)}`, nameWidth + 1)}
                    </text>
                  )}
                </box>
                {isFile ? (
                  <>
                    <text
                      fg={entry?.revertable ? (hot ? C.del : C.dim) : C.bar}
                      onMouseDown={() => fileAct("reject", index)}
                    >
                      {" ↺"}
                    </text>
                    <text fg={hot ? C.add : C.dim} onMouseDown={() => fileAct("accept", index)}>
                      {" ✓"}
                    </text>
                  </>
                ) : (
                  <text fg={C.dim}>{"".padEnd(ICON_COLUMNS)}</text>
                )}
              </box>
            )
          })}

          {/* Overflow hint: keeps the tree from ending in silence when it is cut. */}
          {tree.length > treeHeight ? (
            <box flexDirection="row" height={1} flexShrink={0} backgroundColor={C.side}>
              <text fg={C.marker}>{fit(` ↓ 还有 ${tree.length - treeHeight} 项`, SIDEBAR)}</text>
            </box>
          ) : null}
        </box>

        {/* ---------------- diff ---------------- */}
        <box flexDirection="column" flexGrow={1} height={mainHeight} flexShrink={0} backgroundColor={C.base}>
          {/* File title row: kept one line, banded like the block headers instead of a
              full-width black bar. */}
          <box flexDirection="row" height={1} flexShrink={0} backgroundColor={C.blockBg}>
            <text fg={C.title}>
              {fit(
                ` ${file?.relPath ?? "未选择文件"}${
                  detail ? `   ${detail.hunks.length} 处改动   +${detail.additions} −${detail.deletions}` : ""
                }${detail && detail.totalRows > allRows.length ? "   (超大文件已截断)" : ""}`,
                gutter,
              )}
            </text>
          </box>
          {/* Column header built from the same three segments as data rows, so the
              labels sit exactly above their panes and the panel column lines up. */}
          <box flexDirection="row" height={1} flexShrink={0} backgroundColor={C.blockBg}>
            <box flexDirection="row" width={w.pane + 8} height={1} flexShrink={0}>
              <text fg={C.dim}>{fit("  AI 修改前", w.pane + 8).padEnd(w.pane + 8)}</text>
            </box>
            <box
              flexDirection="row"
              width={w.panel}
              height={1}
              flexShrink={0}
              backgroundColor={C.gutter}
            >
              <text fg={C.line}>{panelCell("rail", w.panel)}</text>
            </box>
            <box flexDirection="row" width={w.pane + 7} height={1} flexShrink={0}>
              <text fg={C.dim}>{fit("当前", w.pane + 7)}</text>
            </box>
          </box>

          {/*
            Native scroll container: the host draws the scrollbar and handles the
            mouse wheel. A hand-rolled window + scrollbar (previous version) looked
            fine but could not be scrolled with the mouse at all.
          */}
          {/*
            Native scroll container. Options come from ScrollBoxOptions in
            @opentui/core: horizontal scrolling is disabled on purpose — rows that are
            one column wide-triggered a stray horizontal scrollbar in the corner, which
            read as a broken widget. Arrows are hidden so only the vertical thumb shows.
          */}
          {/*
            Windowed rendering. The official guidance for heavy content is to render
            only what is visible: 932 rows x 7 nodes made the renderer miss its frame
            budget every tick, which showed up as constant flicker. Now the visible
            window is sliced here and scrolling is driven by state.
          */}
          <box
            flexDirection="row"
            height={diffBodyHeight}
            flexShrink={0}
            onMouseScroll={(event: unknown) => wheel(event, diffBodyHeight)}
          >
            <box flexDirection="column" flexGrow={1} height={diffBodyHeight} flexShrink={0}>
              {lines.slice(scroll, scroll + diffBodyHeight).map((line, index) =>
                typeof line.headerIndex === "number" ? (
                  <box flexDirection="row" height={1} flexShrink={0} backgroundColor={line.bg}>
                    <text fg={line.fg}>{fit(line.left, gutter)}</text>
                  </box>
                ) : (
                  <box flexDirection="row" height={1} flexShrink={0} backgroundColor={line.bg}>
                    <box flexDirection="row" width={w.pane + 8} height={1} flexShrink={0}>
                      <text fg={line.fg}>{line.left}</text>
                    </box>
                    {line.panel === "rail" ? (
                      <box
                        flexDirection="row"
                        width={w.panel}
                        height={1}
                        flexShrink={0}
                        backgroundColor={C.gutter}
                      >
                        <text fg={C.line}>{panelCell("rail", w.panel)}</text>
                      </box>
                    ) : (
                      <box
                        flexDirection="row"
                        width={w.panel}
                        height={1}
                        flexShrink={0}
                        backgroundColor={C.gutterStrong}
                        onMouseDown={() =>
                          decide(
                            line.panel === "accept" ? "accept" : "reject",
                            blocks[line.blockIndex as number],
                          )
                        }
                      >
                        <text fg={line.panel === "accept" ? C.add : C.del}>
                          {panelCell(line.panel, w.panel)}
                        </text>
                      </box>
                    )}
                    <box flexDirection="row" width={w.pane + 7} height={1} flexShrink={0}>
                      <text fg={line.fg}>{line.right}</text>
                    </box>
                  </box>
                ),
              )}
            </box>

            {/* Draggable scrollbar. Dragging needs the whole down → move → up
                sequence on the cells themselves (the column is only one cell wide),
                so each cell reports all three events. */}
            <box flexDirection="column" width={1} height={diffBodyHeight} flexShrink={0}>
              {Array.from({ length: diffBodyHeight }).map((_, index) => {
                const bar = scrollbar(lines.length, diffBodyHeight, scroll)
                const on = index >= bar.from && index <= bar.to
                const track = Math.max(1, diffBodyHeight - 1)
                const target = Math.round((index / track) * maxScroll)
                return (
                  <box
                    height={1}
                    flexShrink={0}
                    onMouseDown={() => {
                      // Click-to-jump only: `onMouseMove` is not delivered to plugin
                      // nodes in this build, so a real drag cannot be implemented.
                      if (target !== scroll) props.navigate({ scroll: target })
                    }}
                  >
                    <text fg={on ? C.thumb : C.track}>{on ? "█" : "░"}</text>
                  </box>
                )
              })}
            </box>
          </box>
        </box>
      </box>

      {/* Spacer: separates the content from the status bar. */}
      <box flexDirection="row" height={1} flexShrink={0} backgroundColor={C.bar}>
        <text fg={C.dim}>{" "}</text>
      </box>

      {/* ---------------- status ---------------- */}
      <box flexDirection="row" flexGrow={0} backgroundColor={C.bar}>
        <text fg={C.marker}>
          {fit(
            ` 共 ${lines.length} 行 · 块 ${
              blocks.length === 0 ? 0 : blockIndex + 1
            }/${blocks.length} · > 同意 · < 不同意 · 滚轮 / ctrl+shift+u d 滚动 · Esc 退出`,
            total,
          )}
        </text>
      </box>
    </box>
  )
}

/* --------------------------- route controller ---------------------------- */

interface RouterLike {
  register?: (input: { name: string; render: (input: { data?: unknown }) => unknown }) => unknown
  navigate?: (input: { type: string; name?: string; data?: unknown; sessionID?: string }) => unknown
  current?: () => { type?: string; sessionID?: string } | undefined
}

/**
 * The host re-invokes the registered `render` callback on every frame. Building a
 * fresh element each time re-mounts the whole page, which is visible as constant
 * flicker. Caching the last element keeps the rendered tree identical while the
 * inputs are unchanged, so the host has nothing to repaint.
 */
let lastRenderKey = ""
let lastRenderElement: unknown = null

export interface DiffPageController {
  available: boolean
  isOpen(): boolean
  open: (data: Partial<DiffPageData> | number, block?: number, scroll?: number) => void
  back: () => void
}

export function createDiffPageController(
  context: TuiPluginContext,
  api: DiffPageApi,
): DiffPageController {
  const router = (context.ui as { router?: RouterLike } | undefined)?.router
  if (!router?.register || !router?.navigate) {
    return { available: false, isOpen: () => false, open: () => {}, back: () => {} }
  }

  let registered = false
  let open = false
  let sessionID = ""
  let last: DiffPageData = {
    file: 0,
    block: 0,
    filter: "",
    collapsed: [],
    hoverFile: -1,
    scroll: 0,
    nonce: 0,
  }

  const navigate = (data: DiffPageData): void => {
    try {
      router.navigate?.({ type: "plugin", name: ROUTE_NAME, data })
    } catch {
      // best effort
    }
  }

  const back = (): void => {
    open = false
    try {
      // Three attempts, cheapest first. Route navigation out of a plugin page has
      // been unreliable on this host, so also ask the tab strip to focus the session.
      if (sessionID) {
        router.navigate?.({ type: "session", sessionID })
        const tabs = (context.ui as { tabs?: { focus?: (id: string) => unknown } } | undefined)
          ?.tabs
        try {
          tabs?.focus?.(sessionID)
        } catch {
          // tab strip optional
        }
        return
      }
      router.navigate?.({ type: "home" })
    } catch {
      // best effort
    }
  }

  const register = (): boolean => {
    if (registered) return true
    try {
      router.register?.({
        name: ROUTE_NAME,
        render: (input) => {
          const raw = (input?.data ?? {}) as Partial<DiffPageData>
          const data: DiffPageData = {
            file: raw.file ?? 0,
            block: raw.block ?? 0,
            filter: raw.filter ?? "",
            collapsed: raw.collapsed ?? [],
            hoverFile: raw.hoverFile ?? -1,
            scroll: raw.scroll ?? 0,
            nonce: raw.nonce ?? 0,
          }

          const key = [
            data.file,
            data.block,
            // `scroll` must be part of the key: it drives the visible window, so
            // leaving it out made every scroll a no-op through the element cache.
            data.scroll,
            data.filter,
            data.nonce,
            data.collapsed.join(","),
            api.list()
              .map((entry) => `${entry.relPath}:${entry.updatedAt}`)
              .join(","),
          ].join("|")

          if (key === lastRenderKey && lastRenderElement) return lastRenderElement

          lastRenderKey = key
          lastRenderElement = (
            <DiffPage data={data} api={api} navigate={(patch) => openWith(patch)} close={back} />
          )
          return lastRenderElement
        },
      })
      registered = true
      return true
    } catch {
      return false
    }
  }

  const openWith = (input: Partial<DiffPageData> | number, block?: number, scroll?: number): void => {
    if (!register()) return
    if (!sessionID) {
      try {
        const current = router.current?.()
        if (current?.sessionID) sessionID = current.sessionID
        if (!sessionID) {
          const sessions = (context.data as { session?: { list?: () => unknown } } | null)?.session?.list?.()
          if (Array.isArray(sessions) && sessions.length > 0) {
            const first = sessions[0] as { id?: string; sessionID?: string }
            const id = first?.id ?? first?.sessionID
            if (typeof id === "string") sessionID = id
          }
        }
      } catch {
        // ignore
      }
    }

    const patch: Partial<DiffPageData> =
      typeof input === "number" ? { file: input, block, scroll } : input

    last = {
      file: patch.file ?? last.file,
      block: patch.block ?? last.block,
      filter: patch.filter ?? last.filter,
      collapsed: patch.collapsed ?? last.collapsed,
      hoverFile: patch.hoverFile ?? last.hoverFile,
      scroll: patch.scroll ?? last.scroll,
      nonce: patch.nonce ?? last.nonce,
    }
    open = true
    navigate(last)
  }

  return { available: true, isOpen: () => open, open: openWith, back }
}
