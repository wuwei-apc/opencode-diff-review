import assert from "node:assert/strict"
import test from "node:test"

import { extractPaths, isInsideRoot, outputPathsOf, toPosix, toRelative } from "../src/paths.ts"

const ROOT = process.platform === "win32" ? "C:\\work\\project" : "/work/project"

test("plain path arguments are found", () => {
  assert.deepEqual(extractPaths("write", { filePath: "src/a.ts", content: "hello" }), ["src/a.ts"])
  assert.deepEqual(extractPaths("edit", { file_path: "src/b.ts" }), ["src/b.ts"])
  assert.deepEqual(extractPaths("write", { path: "src/c.ts" }), ["src/c.ts"])
})

test("nested path arguments are found", () => {
  const paths = extractPaths("edit", { edits: [{ filePath: "src/d.ts" }] })

  assert.deepEqual(paths, ["src/d.ts"])
})

test("apply_patch payloads are parsed for target files", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/e.ts",
    "@@",
    "-old",
    "+new",
    "*** Add File: src/f.ts",
    "*** End Patch",
  ].join("\n")

  const paths = extractPaths("patch", { patch })

  assert.ok(paths.includes("src/e.ts"))
  assert.ok(paths.includes("src/f.ts"))
})

test("unified diff headers are parsed for target files", () => {
  const patch = ["diff --git a/src/g.ts b/src/g.ts", "--- a/src/g.ts", "+++ b/src/g.ts", "@@ -1 +1 @@", "-a", "+b"].join(
    "\n",
  )

  const paths = extractPaths("apply_patch", { input: patch })

  assert.ok(paths.includes("src/g.ts"))
})

test("non-path string arguments are ignored", () => {
  assert.deepEqual(extractPaths("write", { content: "just some text" }), [])
})

test("output paths are read from the shapes a tool result may use", () => {
  assert.deepEqual(outputPathsOf({ outputPaths: ["a.ts", "b.ts"] }), ["a.ts", "b.ts"])
  assert.deepEqual(outputPathsOf({ outputPaths: "a.ts" }), ["a.ts"])
  assert.deepEqual(outputPathsOf({ outputPaths: [{ path: "a.ts" }, { filePath: "b.ts" }] }), [
    "a.ts",
    "b.ts",
  ])
  assert.deepEqual(outputPathsOf({ paths: ["c.ts"] }), ["c.ts"])
  assert.deepEqual(outputPathsOf({}), [])
  assert.deepEqual(outputPathsOf(null), [])
})

test("relative paths stay inside the root", () => {
  assert.ok(isInsideRoot(ROOT, ROOT))
  assert.equal(toRelative(ROOT, "src/a.ts"), "src/a.ts")
})

test("paths escaping the root are rejected", () => {
  assert.equal(toRelative(ROOT, "../outside.ts"), null)
  assert.equal(toRelative(ROOT, "/etc/passwd"), null)
  assert.ok(!isInsideRoot(ROOT, `${ROOT}/../escape`))
})

test("toPosix normalises Windows separators", () => {
  assert.equal(toPosix("a\\b\\c.ts"), "a/b/c.ts")
})
