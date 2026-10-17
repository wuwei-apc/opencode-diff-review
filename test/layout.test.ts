import assert from "node:assert/strict"
import test from "node:test"

import { ROW_OVERHEAD, gridWidths, panelCell } from "../src/layout.ts"

test("grid widths never overrun the terminal and never waste more than one column", () => {
  for (const total of [160, 150, 120, 100, 90, 80, 70, 60]) {
    const w = gridWidths(total)
    const used = w.sidebar + w.scroll + w.panel + w.pane * 2 + ROW_OVERHEAD
    assert.ok(used <= total, `overran at ${total}: used ${used}`)
    assert.ok(total - used <= 1, `wasted ${total - used} columns at ${total}`)
  }
})

test("the panel is a real surface at normal width and narrows on small terminals", () => {
  assert.equal(gridWidths(150).panel, 5)
  assert.equal(gridWidths(90).panel, 3)
  // The scroll rail is dropped before the panes get too cramped.
  assert.equal(gridWidths(60).scroll, 0)
  assert.equal(gridWidths(150).scroll, 2)
})

test("panel cells keep exactly the requested width in every state", () => {
  for (const state of ["rail", "accept", "reject"] as const) {
    for (const width of [3, 5, 7]) {
      assert.equal(panelCell(state, width).length, width)
    }
  }
})

test("panel cells centre their glyph and keep the exact width", () => {
  // Blank rail on purpose: a stale build draws a line here.
  assert.equal(panelCell("rail", 5), "     ")
  assert.equal(panelCell("accept", 5), " ->  ")
  assert.equal(panelCell("reject", 5), " <-  ")
  assert.equal(panelCell("accept", 3), "-> ")
})
