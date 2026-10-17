/**
 * Pure helpers for the file-tree rows.
 *
 * Kept out of `diffview.tsx` on purpose: that module contains JSX, so importing it
 * from a unit test would require the JSX transform. These helpers have no JSX and
 * no side effects, so they can be tested directly.
 */

/** Reserved columns for the two row icons (`↺` and `✓`), including the leading space. */
export const ICON_COLUMNS = 4

/** Width available for the marker + file name, given the sidebar width. */
export function labelWidth(sidebar: number): number {
  return Math.max(4, sidebar - ICON_COLUMNS)
}

/** Truncate to `width`, appending an ellipsis when it does not fit. */
export function truncateLabel(label: string, width: number): string {
  if (width <= 0) return ""
  if (label.length <= width) return label
  return `${label.slice(0, Math.max(0, width - 1))}…`
}

/** The icon column text: `↺` only when the file can still be restored. */
export function iconText(canRevert: boolean): string {
  return canRevert ? "↺ ✓" : "  ✓"
}
