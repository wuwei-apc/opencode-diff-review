/**
 * Option parsing shared by both entrypoints.
 *
 * The server plugin and the panel must agree on these values: the panel renders
 * diffs and decides what is revertable using the same ceilings the server used
 * when it captured the snapshot. Keeping the parsing in one place prevents them
 * from drifting apart.
 */

export interface TrackerOptions {
  /** Snapshot ceiling per file. Larger files are listed but not revertable. */
  maxFileBytes: number
  contextLines: number
  maxLines: number
  /** When non-empty, only these tool names are tracked. */
  trackTools: string[]
}

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
export const DEFAULT_CONTEXT_LINES = 3
export const DEFAULT_MAX_LINES = 600

export function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

export function readTrackerOptions(raw: Record<string, unknown> | undefined): TrackerOptions {
  const source = raw ?? {}
  return {
    maxFileBytes: positiveInteger(source.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    contextLines: positiveInteger(source.contextLines, DEFAULT_CONTEXT_LINES),
    maxLines: positiveInteger(source.maxLines, DEFAULT_MAX_LINES),
    trackTools: stringArray(source.trackTools),
  }
}
