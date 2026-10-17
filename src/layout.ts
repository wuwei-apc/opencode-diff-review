/**
 * Horizontal layout arithmetic for the two-pane diff.
 *
 * Kept free of JSX so it can be unit-tested without a JSX transform.
 */

export const SIDEBAR = 32
export const NUM = 5
export const SCROLLBAR = 2

/** Width of the middle panel: wide enough to read as a surface, not a line. */
export const PANEL_WIDE = 5
export const PANEL_NARROW = 3

export interface GridWidths {
  sidebar: number
  num: number
  pane: number
  panel: number
  scroll: number
}

/**
 * Columns a diff row spends outside the two panes:
 *   left  = " " + sign + num(5) + " " + pane  → pane + 8
 *   right =        sign + num(5) + " " + pane → pane + 7
 * so the pair needs `2*pane + ROW_OVERHEAD`.
 */
export const ROW_OVERHEAD = 15

/**
 * Every horizontal budget in one place.
 * Invariant: `sidebar + scroll + panel + 2*pane + ROW_OVERHEAD <= total`.
 */
export function gridWidths(total: number): GridWidths {
  const panel = total >= 100 ? PANEL_WIDE : PANEL_NARROW
  const sidebar = total >= 80 ? SIDEBAR : 20
  const scroll = total >= 80 ? SCROLLBAR : 0
  const pane = Math.max(
    8,
    Math.floor((total - sidebar - scroll - panel - ROW_OVERHEAD) / 2),
  )
  return { sidebar, num: NUM, pane, panel, scroll }
}

export type PanelState = "rail" | "accept" | "reject"

/**
 * One fixed-width cell of the middle panel.
 *
 * Two-character ASCII arrows (`->` / `<-`) instead of `→` / `←`: the Unicode
 * arrows are East-Asian-ambiguous width, render two columns wide in CJK terminals
 * and overflowed the panel. The rail state is a blank band, which also makes a
 * stale build obvious (an old module draws a line down the middle).
 */
export function panelCell(state: PanelState, width: number): string {
  const glyph = state === "accept" ? "->" : state === "reject" ? "<-" : ""
  const pad = Math.max(0, width - glyph.length)
  const left = Math.floor(pad / 2)
  return `${" ".repeat(left)}${glyph}${" ".repeat(pad - left)}`
}
