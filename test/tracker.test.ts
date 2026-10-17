import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { ChangeTracker } from "../src/tracker.ts"

function makeTracker(root: string, maxFileBytes = 1024 * 1024): ChangeTracker {
  return new ChangeTracker({
    root,
    stateDir: join(root, ".state"),
    maxFileBytes,
    contextLines: 3,
    maxLines: 200,
    trackTools: [],
  })
}

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "opencode-diff-test-"))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a modified file is tracked and reverted to its original content", () => {
  withRoot((root) => {
    const file = join(root, "a.txt")
    writeFileSync(file, "one\ntwo\nthree\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("a.txt")
    assert.equal(pre.snapshot?.exists, true)

    writeFileSync(file, "one\nTWO\nthree\n")
    assert.equal(tracker.recordAfter({ relPath: "a.txt", tool: "edit", sessionID: "s1", pre }), true)

    const list = tracker.listPayload("all", "s1")
    assert.equal(list.entries.length, 1)

    const entry = list.entries[0]
    assert.equal(entry.relPath, "a.txt")
    assert.equal(entry.status, "modified")
    assert.equal(entry.revertable, true)
    assert.equal(entry.additions, 1)
    assert.equal(entry.deletions, 1)

    const reverted = tracker.revertPayload("a.txt")
    assert.equal(reverted.ok, true)
    assert.equal(readFileSync(file, "utf8"), "one\ntwo\nthree\n")
    assert.equal(tracker.listPayload("all", "s1").entries.length, 0)
  })
})

test("a file created by the AI is removed on revert", () => {
  withRoot((root) => {
    const file = join(root, "new.txt")
    const tracker = makeTracker(root)

    const pre = tracker.captureBaseline("new.txt")
    assert.equal(pre.snapshot?.exists, false)

    writeFileSync(file, "hello\n")
    assert.equal(tracker.recordAfter({ relPath: "new.txt", tool: "write", sessionID: "s1", pre }), true)

    const entry = tracker.listPayload("all", "s1").entries[0]
    assert.equal(entry.status, "added")
    assert.equal(entry.revertable, true)

    assert.equal(tracker.revertPayload("new.txt").ok, true)
    assert.equal(existsSync(file), false)
  })
})

test("a file deleted by the AI is restored on revert", () => {
  withRoot((root) => {
    const file = join(root, "gone.txt")
    writeFileSync(file, "keep me\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("gone.txt")
    unlinkSync(file)
    assert.equal(tracker.recordAfter({ relPath: "gone.txt", tool: "delete", sessionID: "s1", pre }), true)

    const entry = tracker.listPayload("all", "s1").entries[0]
    assert.equal(entry.status, "deleted")

    assert.equal(tracker.revertPayload("gone.txt").ok, true)
    assert.equal(readFileSync(file, "utf8"), "keep me\n")
  })
})

test("touching a file without changing it records nothing", () => {
  withRoot((root) => {
    const file = join(root, "same.txt")
    writeFileSync(file, "unchanged\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("same.txt")
    assert.equal(tracker.recordAfter({ relPath: "same.txt", tool: "read", sessionID: "s1", pre }), false)
    assert.equal(tracker.size, 0)
  })
})

test("the baseline stays at the state before the first AI edit", () => {
  withRoot((root) => {
    const file = join(root, "multi.txt")
    writeFileSync(file, "v1\n")

    const tracker = makeTracker(root)

    const first = tracker.captureBaseline("multi.txt")
    writeFileSync(file, "v2\n")
    tracker.recordAfter({ relPath: "multi.txt", tool: "edit", sessionID: "s1", pre: first })

    const second = tracker.captureBaseline("multi.txt")
    writeFileSync(file, "v3\n")
    tracker.recordAfter({ relPath: "multi.txt", tool: "edit", sessionID: "s1", pre: second })

    const entry = tracker.listPayload("all", "s1").entries[0]
    assert.equal(entry.touches, 2)
    assert.deepEqual(entry.tools, ["edit"])

    assert.equal(tracker.revertPayload("multi.txt").ok, true)
    assert.equal(readFileSync(file, "utf8"), "v1\n")
  })
})

test("returning a file to its original content drops the entry", () => {
  withRoot((root) => {
    const file = join(root, "flip.txt")
    writeFileSync(file, "base\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("flip.txt")
    writeFileSync(file, "changed\n")
    tracker.recordAfter({ relPath: "flip.txt", tool: "edit", sessionID: "s1", pre })
    assert.equal(tracker.size, 1)

    const back = tracker.captureBaseline("flip.txt")
    writeFileSync(file, "base\n")
    assert.equal(tracker.recordAfter({ relPath: "flip.txt", tool: "edit", sessionID: "s1", pre: back }), false)
    assert.equal(tracker.size, 0)
  })
})

test("revertAll restores every tracked file", () => {
  withRoot((root) => {
    const first = join(root, "one.txt")
    const second = join(root, "two.txt")
    writeFileSync(first, "one\n")
    writeFileSync(second, "two\n")

    const tracker = makeTracker(root)

    const preFirst = tracker.captureBaseline("one.txt")
    const preSecond = tracker.captureBaseline("two.txt")
    writeFileSync(first, "ONE\n")
    writeFileSync(second, "TWO\n")
    tracker.recordAfter({ relPath: "one.txt", tool: "write", sessionID: "s1", pre: preFirst })
    tracker.recordAfter({ relPath: "two.txt", tool: "write", sessionID: "s1", pre: preSecond })

    const result = tracker.revertAllPayload("all", "s1")
    assert.equal(result.ok, true)
    assert.equal(result.reverted.length, 2)
    assert.deepEqual(result.failed, [])

    assert.equal(readFileSync(first, "utf8"), "one\n")
    assert.equal(readFileSync(second, "utf8"), "two\n")
    assert.equal(tracker.size, 0)
  })
})

test("a file above the snapshot ceiling cannot be reverted", () => {
  withRoot((root) => {
    const file = join(root, "big.txt")
    writeFileSync(file, "0123456789")

    const tracker = makeTracker(root, 4)
    const pre = tracker.captureBaseline("big.txt")
    assert.equal(pre.snapshot, null)
    assert.equal(pre.truncated, true)

    writeFileSync(file, "abc")
    tracker.recordAfter({ relPath: "big.txt", tool: "write", sessionID: "s1", pre })

    const entry = tracker.listPayload("all", "s1").entries[0]
    assert.equal(entry.revertable, false)
    assert.equal(entry.status, "unknown")

    const reverted = tracker.revertPayload("big.txt")
    assert.equal(reverted.ok, false)
    assert.match(reverted.message, /快照上限/)
    // The file on disk must be left alone when we cannot restore it.
    assert.equal(readFileSync(file, "utf8"), "abc")
  })
})

test("binary content round-trips through revert", () => {
  withRoot((root) => {
    const file = join(root, "blob.bin")
    const original = Buffer.from([0, 1, 2, 3, 255])
    writeFileSync(file, original)

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("blob.bin")
    writeFileSync(file, Buffer.from([9, 9, 9]))

    tracker.recordAfter({ relPath: "blob.bin", tool: "write", sessionID: "s1", pre })

    const entry = tracker.listPayload("all", "s1").entries[0]
    assert.equal(entry.binary, true)

    assert.equal(tracker.revertPayload("blob.bin").ok, true)
    assert.deepEqual(readFileSync(file), original)
  })
})

test("paths outside the session directory are never tracked", () => {
  withRoot((root) => {
    const tracker = makeTracker(root)

    assert.deepEqual(tracker.candidatePaths("write", { filePath: "../escape.txt" }), [])
    assert.deepEqual(tracker.candidatePaths("write", { filePath: "node_modules/pkg/index.js" }), [])
    assert.deepEqual(tracker.candidatePaths("write", { filePath: "src/ok.ts" }), ["src/ok.ts"])
  })
})

test("clear drops tracking without touching the file", () => {
  withRoot((root) => {
    const file = join(root, "keep.txt")
    writeFileSync(file, "before\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("keep.txt")
    writeFileSync(file, "after\n")
    tracker.recordAfter({ relPath: "keep.txt", tool: "write", sessionID: "s1", pre })

    const cleared = tracker.clearPayload("", "all", "s1")
    assert.equal(cleared.ok, true)
    assert.equal(cleared.cleared, 1)
    assert.equal(readFileSync(file, "utf8"), "after\n")
    assert.equal(tracker.size, 0)
  })
})

test("a single hunk reverts while the other changes stay on disk", () => {
  withRoot((root) => {
    const file = join(root, "hunks.txt")
    const original = Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n") + "\n"
    writeFileSync(file, original)

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("hunks.txt")
    const modified = original.replace("l2\n", "L2\n").replace("l11\n", "L11\n")
    writeFileSync(file, modified)
    tracker.recordAfter({ relPath: "hunks.txt", tool: "edit", sessionID: "s1", pre })

    const detail = tracker.diffDetailPayload("hunks.txt")
    assert.equal(detail.hunks.length, 2)
    assert.equal(detail.partialRevertable, true)

    const first = detail.hunks[0]
    const rows = first.rows.filter((row) => row.kind !== "context").map((row) => row.rowIndex)
    const result = tracker.revertRowsPayload("hunks.txt", rows, detail.updatedAt)

    assert.equal(result.ok, true)
    assert.equal(result.remaining, 1)

    const now = readFileSync(file, "utf8")
    assert.ok(now.includes("l2\n"), "第一处改动应被还原")
    assert.ok(now.includes("L11\n"), "第二处改动应保留")
  })
})

test("a single added line reverts without touching the other changes", () => {
  withRoot((root) => {
    const file = join(root, "line.txt")
    writeFileSync(file, "a\nb\nX\nc\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("line.txt")
    writeFileSync(file, "a\nb\nY\nc\nNEW\n")
    tracker.recordAfter({ relPath: "line.txt", tool: "edit", sessionID: "s1", pre })

    const detail = tracker.diffDetailPayload("line.txt")
    const added = detail.hunks
      .flatMap((hunk) => hunk.rows)
      .find((row) => row.kind === "add" && row.text === "NEW")
    assert.ok(added, "应能找到新增行")

    const result = tracker.revertRowsPayload("line.txt", [added.rowIndex], detail.updatedAt)
    assert.equal(result.ok, true)
    assert.equal(readFileSync(file, "utf8"), "a\nb\nY\nc\n")
    assert.equal(tracker.size, 1, "还有未撤回的改动，记录应保留")
  })
})

test("reverting every changed row degrades to a whole-file revert", () => {
  withRoot((root) => {
    const file = join(root, "all.txt")
    writeFileSync(file, "one\ntwo\nthree\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("all.txt")
    writeFileSync(file, "one\nTWO\nthree\n")
    tracker.recordAfter({ relPath: "all.txt", tool: "edit", sessionID: "s1", pre })

    const detail = tracker.diffDetailPayload("all.txt")
    const rows = detail.hunks
      .flatMap((hunk) => hunk.rows)
      .filter((row) => row.kind !== "context")
      .map((row) => row.rowIndex)

    const result = tracker.revertRowsPayload("all.txt", rows, detail.updatedAt)
    assert.equal(result.ok, true)
    assert.equal(result.remaining, 0)
    assert.equal(readFileSync(file, "utf8"), "one\ntwo\nthree\n")
    assert.equal(tracker.size, 0)
  })
})

test("line revert preserves CRLF line endings", () => {
  withRoot((root) => {
    const file = join(root, "crlf.txt")
    writeFileSync(file, "a\r\nb\r\nc\r\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("crlf.txt")
    writeFileSync(file, "a\r\nB\r\nc\r\nNEW\r\n")
    tracker.recordAfter({ relPath: "crlf.txt", tool: "edit", sessionID: "s1", pre })

    const detail = tracker.diffDetailPayload("crlf.txt")
    const added = detail.hunks
      .flatMap((hunk) => hunk.rows)
      .find((row) => row.kind === "add" && row.text === "NEW")
    assert.ok(added)

    tracker.revertRowsPayload("crlf.txt", [added.rowIndex], detail.updatedAt)
    assert.equal(readFileSync(file, "utf8"), "a\r\nB\r\nc\r\n")
  })
})

test("partial revert refuses a stale updatedAt token", () => {
  withRoot((root) => {
    const file = join(root, "stale.txt")
    writeFileSync(file, "a\nb\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("stale.txt")
    writeFileSync(file, "a\nB\n")
    tracker.recordAfter({ relPath: "stale.txt", tool: "edit", sessionID: "s1", pre })

    const detail = tracker.diffDetailPayload("stale.txt")
    const result = tracker.revertRowsPayload("stale.txt", [1], detail.updatedAt - 1)

    assert.equal(result.ok, false)
    assert.match(result.message, /变化/)
  })
})

test("accepting a hunk keeps the file and rebases the baseline", () => {
  withRoot((root) => {
    const file = join(root, "accept.txt")
    const original = Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n") + "\n"
    const modified = original.replace("l2\n", "L2\n").replace("l11\n", "L11\n")
    writeFileSync(file, original)

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("accept.txt")
    writeFileSync(file, modified)
    tracker.recordAfter({ relPath: "accept.txt", tool: "edit", sessionID: "s1", pre })

    const detail = tracker.diffDetailPayload("accept.txt")
    const second = detail.hunks[1]
    const rows = second.rows.filter((row) => row.kind !== "context").map((row) => row.rowIndex)

    const accepted = tracker.acceptRowsPayload("accept.txt", rows, detail.updatedAt)
    assert.equal(accepted.ok, true)
    assert.equal(accepted.remaining, 1)
    assert.equal(readFileSync(file, "utf8"), modified, "同意不应改动文件")

    // Reverting what is left must keep the accepted change.
    const detail2 = tracker.diffDetailPayload("accept.txt")
    const rest = detail2.hunks[0].rows
      .filter((row) => row.kind !== "context")
      .map((row) => row.rowIndex)
    tracker.revertRowsPayload("accept.txt", rest, detail2.updatedAt)

    const finalText = readFileSync(file, "utf8")
    assert.ok(finalText.includes("l2\n"), "未同意的块应被还原")
    assert.ok(finalText.includes("L11\n"), "已同意的块应保留")
    assert.equal(tracker.size, 0)
  })
})

test("accepting every change removes the entry without touching the file", () => {
  withRoot((root) => {
    const file = join(root, "accept-all.txt")
    writeFileSync(file, "one\ntwo\n")

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("accept-all.txt")
    writeFileSync(file, "one\nTWO\n")
    tracker.recordAfter({ relPath: "accept-all.txt", tool: "edit", sessionID: "s1", pre })

    const detail = tracker.diffDetailPayload("accept-all.txt")
    const rows = detail.hunks
      .flatMap((hunk) => hunk.rows)
      .filter((row) => row.kind !== "context")
      .map((row) => row.rowIndex)

    const accepted = tracker.acceptRowsPayload("accept-all.txt", rows, detail.updatedAt)
    assert.equal(accepted.ok, true)
    assert.equal(accepted.remaining, 0)
    assert.equal(readFileSync(file, "utf8"), "one\nTWO\n")
    assert.equal(tracker.size, 0)
  })
})

test("agreeing to everything clears the list without touching files", () => {
  withRoot((root) => {
    const file = join(root, "clear-all.txt")
    const original = Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n") + "\n"
    const modified = original.replace("l2\n", "L2\n").replace("l11\n", "L11\n")
    writeFileSync(file, original)

    const tracker = makeTracker(root)
    const pre = tracker.captureBaseline("clear-all.txt")
    writeFileSync(file, modified)
    tracker.recordAfter({ relPath: "clear-all.txt", tool: "edit", sessionID: "s1", pre })

    // Accept one block first, then agree to everything (the global menu action).
    const detail = tracker.diffDetailPayload("clear-all.txt")
    const firstRows = detail.hunks[0].rows
      .filter((row) => row.kind !== "context")
      .map((row) => row.rowIndex)
    tracker.acceptRowsPayload("clear-all.txt", firstRows, detail.updatedAt)

    const cleared = tracker.clearPayload("", "all", "")
    assert.equal(cleared.ok, true)
    assert.equal(cleared.cleared, 1)
    assert.equal(readFileSync(file, "utf8"), modified, "同意/清空都不应改动文件")
    assert.equal(tracker.size, 0)
  })
})
