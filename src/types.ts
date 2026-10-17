/**
 * Payload shapes shared by the tracker, the server plugin and the panel.
 *
 * These used to double as the RPC contract. The transport is now the file store
 * (see `store.ts`), but the shapes are kept stable because they are what the UI
 * renders and what the tracker returns.
 */

export type ChangeStatus = "modified" | "added" | "deleted" | "unknown"

/** `all` lists every pending change in the project, `session` filters by session. */
export type ChangeScope = "all" | "session"

export interface ChangeSummary {
  /** Absolute path (informational; use `relPath` for round-trips). */
  path: string
  relPath: string
  status: ChangeStatus
  additions: number
  deletions: number
  binary: boolean
  /** False when no pre-image was captured, so the file cannot be restored safely. */
  revertable: boolean
  /** True when the pre-image was skipped or the diff was cut short. */
  truncated: boolean
  touches: number
  tools: string[]
  sessionID: string
  updatedAt: number
}

export interface ListPayload {
  root: string
  entries: ChangeSummary[]
  generatedAt: number
}

export interface DiffPayload {
  path: string
  relPath: string
  status: ChangeStatus
  unified: string
  additions: number
  deletions: number
  truncated: boolean
  approximate: boolean
  binary: boolean
  revertable: boolean
  /** Human readable reason when `revertable` is false or the diff is empty. */
  message: string
}

export interface RevertPayload {
  ok: boolean
  path: string
  relPath: string
  message: string
}

export interface RevertAllPayload {
  ok: boolean
  reverted: string[]
  failed: Array<{ path: string; message: string }>
  message: string
}

export interface ClearPayload {
  ok: boolean
  cleared: number
  message: string
}

/* -------------------------------------------------------------------------- */
/* Line-level (diff view)                                                     */
/* -------------------------------------------------------------------------- */

/** One aligned diff row, addressed by `rowIndex` for per-line revert. */
export interface DiffRowView {
  rowIndex: number
  kind: "context" | "add" | "del"
  text: string
  /** 1-based line number: in the baseline for `del`, in the current file otherwise. */
  lineNo: number
  /** 1-based line number on the left (baseline) side; 0 when absent there. */
  oldLine: number
  /** 1-based line number on the right (current) side; 0 when absent there. */
  newLine: number
}

export interface DiffHunkView {
  index: number
  header: string
  oldStart: number
  newStart: number
  additions: number
  deletions: number
  rows: DiffRowView[]
}

/**
 * Everything the diff browser needs: the hunks plus the identifiers required to
 * revert a block or individual lines later.
 */
export interface DiffDetailPayload {
  path: string
  relPath: string
  status: ChangeStatus
  /** False when the whole file cannot be restored at all (no baseline). */
  revertable: boolean
  /** False when partial revert is unsafe (binary, deleted file, approximate diff). */
  partialRevertable: boolean
  binary: boolean
  approximate: boolean
  truncated: boolean
  additions: number
  deletions: number
  /** Optimistic concurrency token: changes whenever the entry is re-recorded. */
  updatedAt: number
  message: string
  hunks: DiffHunkView[]
  /**
   * Every aligned row of the whole file (context included), so a viewer can show a
   * continuous side-by-side comparison instead of disconnected hunks. Capped; when
   * `totalRows > allRows.length` the caller is looking at a truncated prefix.
   */
  allRows: DiffRowView[]
  totalRows: number
}

export interface PartialRevertPayload {
  ok: boolean
  path: string
  relPath: string
  message: string
  /** Number of hunks left after the operation. */
  remaining: number
}

