import assert from "node:assert/strict"
import test from "node:test"

import { diffRows, diffText, splitLines, toHunks } from "../src/diff.ts"

test("splitLines tolerates CRLF and a missing trailing newline", () => {
  assert.deepEqual(splitLines(""), [])
  assert.deepEqual(splitLines("a\n"), ["a"])
  assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"])
  assert.deepEqual(splitLines("a\nb"), ["a", "b"])
})

test("a one-line change produces one hunk with correct counts", () => {
  const result = diffText("a\nb\nc\n", "a\nB\nc\n", { label: "x.txt" })

  assert.equal(result.additions, 1)
  assert.equal(result.deletions, 1)
  assert.equal(result.hunks.length, 1)
  assert.equal(result.approximate, false)

  assert.match(result.unified, /^--- a\/x\.txt$/m)
  assert.match(result.unified, /^\+\+\+ b\/x\.txt$/m)
  assert.match(result.unified, /^@@ -1,3 \+1,3 @@$/m)
  assert.match(result.unified, /^-b$/m)
  assert.match(result.unified, /^\+B$/m)
  assert.match(result.unified, /^ a$/m)
})

test("identical content yields no hunks", () => {
  const result = diffText("a\nb\n", "a\nb\n")

  assert.equal(result.hunks.length, 0)
  assert.equal(result.additions, 0)
  assert.equal(result.deletions, 0)
  assert.equal(result.unified, "--- a/file\n+++ b/file")
})

test("a created file diffs against /dev/null", () => {
  const result = diffText(null, "x\ny\n", { label: "new.txt" })

  assert.equal(result.additions, 2)
  assert.equal(result.deletions, 0)
  assert.match(result.unified, /^--- \/dev\/null$/m)
  assert.match(result.unified, /^\+\+\+ b\/new\.txt$/m)
  assert.match(result.unified, /^@@ -1,0 \+1,2 @@$/m)
})

test("a deleted file diffs against /dev/null", () => {
  const result = diffText("x\ny\n", null, { label: "gone.txt" })

  assert.equal(result.additions, 0)
  assert.equal(result.deletions, 2)
  assert.match(result.unified, /^--- a\/gone\.txt$/m)
  assert.match(result.unified, /^\+\+\+ \/dev\/null$/m)
})

test("CRLF input is normalised before diffing", () => {
  const result = diffText("a\r\nb\r\n", "a\r\nc\r\n")

  assert.equal(result.additions, 1)
  assert.equal(result.deletions, 1)
  assert.doesNotMatch(result.unified, /\r/)
})

test("distant changes become separate hunks", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line${index}`)
  const after = [...before]
  after[5] = "CHANGED5"
  after[25] = "CHANGED25"

  const result = diffText(before.join("\n"), after.join("\n"))

  assert.equal(result.hunks.length, 2)
  assert.equal(result.hunks[0].oldStart, 3)
  assert.equal(result.hunks[0].oldCount, 7)
  assert.equal(result.hunks[0].newCount, 7)
})

test("nearby changes merge into a single hunk", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line${index}`)
  const after = [...before]
  after[10] = "A"
  after[12] = "B"

  const result = diffText(before.join("\n"), after.join("\n"))

  assert.equal(result.hunks.length, 1)
})

test("identical head and tail are trimmed but kept as context", () => {
  const before = ["1", "2", "3", "4", "5", "6", "7", "8"]
  const after = ["1", "2", "3", "X", "5", "6", "7", "8"]

  const { rows } = diffRows(before, after)
  const hunks = toHunks(rows, 3)

  assert.equal(rows.length, 9)
  assert.equal(hunks.length, 1)
  // 3 lines of head context + the changed pair + 3 lines of tail context.
  assert.equal(hunks[0].lines.length, 8)
})

test("an oversized rewrite falls back to whole-section replacement", () => {
  const before = Array.from({ length: 1200 }, (_, index) => `a${index}`).join("\n")
  const after = Array.from({ length: 1200 }, (_, index) => `b${index}`).join("\n")

  const result = diffText(before, after, { maxLines: 10 })

  assert.equal(result.approximate, true)
  assert.equal(result.truncated, true)
  assert.equal(result.additions, 1200)
  assert.equal(result.deletions, 1200)
})

test("maxLines caps the rendered text", () => {
  const before = Array.from({ length: 200 }, (_, index) => `a${index}`).join("\n")
  const after = Array.from({ length: 200 }, (_, index) => `b${index}`).join("\n")

  const result = diffText(before, after, { maxLines: 20 })

  assert.equal(result.truncated, true)
  assert.ok(result.unified.split("\n").length <= 20)
})
