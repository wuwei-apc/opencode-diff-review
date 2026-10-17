import assert from "node:assert/strict"
import test from "node:test"

import { ICON_COLUMNS, iconText, labelWidth, truncateLabel } from "../src/tree.ts"

test("the label column leaves room for both icons", () => {
  assert.equal(labelWidth(30), 30 - ICON_COLUMNS)
  // Never degenerate to zero or negative, even in a very narrow sidebar.
  assert.equal(labelWidth(4), 4)
  assert.equal(labelWidth(0), 4)
})

test("labels are truncated with an ellipsis, never overflowing", () => {
  assert.equal(truncateLabel("todo.html", 9), "todo.html")
  assert.equal(truncateLabel("averylongfilename.ts", 9), "averylon…")
  assert.equal(truncateLabel("averylongfilename.ts", 9).length, 9)
  assert.equal(truncateLabel("x", 0), "")
})

test("the revert icon is omitted when the file cannot be restored", () => {
  assert.equal(iconText(true), "↺ ✓")
  assert.equal(iconText(false), "  ✓")
  assert.equal(iconText(true).length, ICON_COLUMNS - 1)
})
