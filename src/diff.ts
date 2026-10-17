/**
 * A small, dependency-free line diff.
 *
 * `opencode` ships no diff helper that plugins can import, and pulling a
 * library into a plugin directory is awkward, so this module implements the
 * subset we need:
 *
 *   - LCS based line diff with common prefix/suffix trimming,
 *   - a hard cell budget so a pathological file cannot freeze the server,
 *   - unified `@@` hunks with configurable context.
 *
 * When the middle section exceeds the budget the region is rendered as a whole
 * replacement (all deletions then all additions) and flagged `approximate`, so
 * the UI can say so instead of silently lying.
 */

export type DiffLineKind = "context" | "add" | "del"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Absolute index of this hunk's first row inside the full row array. */
  rowStart: number
  /** Absolute index of this hunk's last row inside the full row array. */
  rowEnd: number
  lines: DiffLine[]
}

/**
 * Absolute row indexes of the changed (non-context) rows of a hunk.
 *
 * Used to revert a whole hunk by line, which keeps one code path for "revert this
 * block" and "revert these lines".
 */
export function changedRowIndexes(hunk: DiffHunk): number[] {
  const result: number[] = []
  for (let offset = 0; offset < hunk.lines.length; offset += 1) {
    if (hunk.lines[offset].kind !== "context") result.push(hunk.rowStart + offset)
  }
  return result
}

export interface DiffResult {
  hunks: DiffHunk[]
  additions: number
  deletions: number
  /** Unified diff text (may be cut short when `maxLines` is reached). */
  unified: string
  /** True when the unified text was cut short. */
  truncated: boolean
  /** True when a section was too large for an exact diff. */
  approximate: boolean
}

export interface DiffOptions {
  contextLines?: number
  maxLines?: number
  /** File label used in the `---` / `+++` headers. */
  label?: string
}

/** Above this many DP cells we stop trying to be exact. */
const LCS_CELL_BUDGET = 1_000_000

/** Split text into lines, tolerating CRLF and a missing trailing newline. */
export function splitLines(text: string): string[] {
  if (text === "") return []
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = normalized.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

function lcsRows(
  before: string[],
  after: string[],
): { rows: DiffLine[]; approximate: boolean } {
  const n = before.length
  const m = after.length

  if (n === 0) {
    return { rows: after.map((text) => ({ kind: "add" as const, text })), approximate: false }
  }
  if (m === 0) {
    return { rows: before.map((text) => ({ kind: "del" as const, text })), approximate: false }
  }

  if (n * m > LCS_CELL_BUDGET) {
    return {
      rows: [
        ...before.map((text) => ({ kind: "del" as const, text })),
        ...after.map((text) => ({ kind: "add" as const, text })),
      ],
      approximate: true,
    }
  }

  const width = m + 1
  // dp[i][j] = LCS length of before[i..] and after[j..]
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    const rowBase = i * width
    const nextBase = rowBase + width
    for (let j = m - 1; j >= 0; j -= 1) {
      if (before[i] === after[j]) {
        dp[rowBase + j] = dp[nextBase + j + 1] + 1
      } else {
        const skipBefore = dp[nextBase + j]
        const skipAfter = dp[rowBase + j + 1]
        dp[rowBase + j] = skipBefore >= skipAfter ? skipBefore : skipAfter
      }
    }
  }

  const rows: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      rows.push({ kind: "context", text: before[i] })
      i += 1
      j += 1
      continue
    }
    if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      rows.push({ kind: "del", text: before[i] })
      i += 1
    } else {
      rows.push({ kind: "add", text: after[j] })
      j += 1
    }
  }
  while (i < n) {
    rows.push({ kind: "del", text: before[i] })
    i += 1
  }
  while (j < m) {
    rows.push({ kind: "add", text: after[j] })
    j += 1
  }

  return { rows, approximate: false }
}

/** Aligned rows for two line arrays (trim common head and tail first). */
export function diffRows(
  before: string[],
  after: string[],
): { rows: DiffLine[]; approximate: boolean } {
  let start = 0
  const shortest = Math.min(before.length, after.length)
  while (start < shortest && before[start] === after[start]) start += 1

  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }

  const head = before.slice(0, start)
  const tail = before.slice(endBefore)
  const middle = lcsRows(before.slice(start, endBefore), after.slice(start, endAfter))

  return {
    rows: [
      ...head.map((text) => ({ kind: "context" as const, text })),
      ...middle.rows,
      ...tail.map((text) => ({ kind: "context" as const, text })),
    ],
    approximate: middle.approximate,
  }
}

/** Group aligned rows into unified hunks. */
export function toHunks(rows: DiffLine[], contextLines = 3): DiffHunk[] {
  const changedIndexes: number[] = []
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind !== "context") changedIndexes.push(index)
  }
  if (changedIndexes.length === 0) return []

  const context = Math.max(0, contextLines)
  const ranges: Array<[number, number]> = []
  for (const index of changedIndexes) {
    const from = Math.max(0, index - context)
    const to = Math.min(rows.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to)
    } else {
      ranges.push([from, to])
    }
  }

  const hunks: DiffHunk[] = []
  let oldNumber = 1
  let newNumber = 1
  let cursor = 0

  for (const [from, to] of ranges) {
    while (cursor < from) {
      const row = rows[cursor]
      if (row.kind !== "add") oldNumber += 1
      if (row.kind !== "del") newNumber += 1
      cursor += 1
    }

    const oldStart = oldNumber
    const newStart = newNumber
    const lines: DiffLine[] = []

    for (let index = from; index <= to; index += 1) {
      const row = rows[index]
      lines.push(row)
      if (row.kind !== "add") oldNumber += 1
      if (row.kind !== "del") newNumber += 1
    }
    cursor = to + 1

    hunks.push({
      oldStart,
      oldCount: lines.filter((line) => line.kind !== "add").length,
      newStart,
      newCount: lines.filter((line) => line.kind !== "del").length,
      rowStart: from,
      rowEnd: to,
      lines,
    })
  }

  return hunks
}

export function renderUnified(
  hunks: DiffHunk[],
  labels: { before: string; after: string },
  maxLines: number,
): { text: string; truncated: boolean } {
  const output: string[] = [`--- ${labels.before}`, `+++ ${labels.after}`]
  let truncated = false

  outer: for (const hunk of hunks) {
    if (output.length >= maxLines) {
      truncated = true
      break
    }
    output.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
    for (const line of hunk.lines) {
      if (output.length >= maxLines) {
        truncated = true
        break outer
      }
      const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "
      output.push(prefix + line.text)
    }
  }

  return { text: output.join("\n"), truncated }
}

/**
 * Diff two optional texts.
 *
 * `null` means "file did not exist", which produces `/dev/null` headers so a
 * created or deleted file reads naturally.
 */
export function diffText(
  before: string | null,
  after: string | null,
  options: DiffOptions = {},
): DiffResult {
  const label = options.label ?? "file"
  const contextLines = options.contextLines ?? 3
  const maxLines = options.maxLines ?? 2000

  const beforeLines = before === null ? [] : splitLines(before)
  const afterLines = after === null ? [] : splitLines(after)

  const { rows, approximate } = diffRows(beforeLines, afterLines)
  const hunks = toHunks(rows, contextLines)

  let additions = 0
  let deletions = 0
  for (const row of rows) {
    if (row.kind === "add") additions += 1
    else if (row.kind === "del") deletions += 1
  }

  const rendered = renderUnified(
    hunks,
    {
      before: before === null ? "/dev/null" : `a/${label}`,
      after: after === null ? "/dev/null" : `b/${label}`,
    },
    maxLines,
  )

  return {
    hunks,
    additions,
    deletions,
    unified: rendered.text,
    truncated: rendered.truncated,
    approximate,
  }
}
