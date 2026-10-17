/**
 * Path helpers: normalize tool arguments into repository-relative paths and
 * keep every filesystem operation inside the session directory.
 */

import { isAbsolute, relative, resolve, sep } from "node:path"

/** Argument keys that conventionally carry a target file path. */
const PATH_KEYS = new Set([
  "filepath",
  "file_path",
  "path",
  "file",
  "filename",
  "target",
  "targetpath",
  "target_path",
  "destination",
  "dest",
  "sourcepath",
  "source_path",
  "absolutepath",
  "absolute_path",
  "newpath",
  "new_path",
  "oldpath",
  "old_path",
  "from",
  "to",
])

const PATCH_LINE_PATTERNS: readonly RegExp[] = [
  /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm,
  /^\*\*\* Move to:\s*(.+?)\s*$/gm,
  /^diff --git a\/(.+?) b\/(.+?)\s*$/gm,
  /^\+\+\+ b\/(.+?)\s*$/gm,
  /^--- a\/(.+?)\s*$/gm,
]

export function toPosix(value: string): string {
  return value.split(sep).join("/").replace(/\\/g, "/")
}

/** True when `target` is `root` itself or lives below it. */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (rel === "") return true
  return !rel.startsWith("..") && !isAbsolute(rel)
}

/** Repository-relative, posix-style path; `null` when it escapes `root`. */
export function toRelative(root: string, target: string): string | null {
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target)
  if (!isInsideRoot(root, abs)) return null
  const rel = toPosix(relative(root, abs))
  return rel === "" ? null : rel
}

/** Absolute path for a relative reference, or `null` when it escapes `root`. */
export function resolveInside(root: string, candidate: string): string | null {
  if (!candidate) return null
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  return isInsideRoot(root, abs) ? abs : null
}

function looksLikePatch(text: string): boolean {
  return (
    text.includes("*** Begin Patch") ||
    text.includes("*** Update File:") ||
    text.includes("*** Add File:") ||
    text.includes("*** Delete File:") ||
    text.startsWith("diff --git ") ||
    text.includes("\n+++ ") ||
    text.includes("\n--- ")
  )
}

function collectPatchPaths(text: string, into: Set<string>): void {
  for (const pattern of PATCH_LINE_PATTERNS) {
    // `diff --git a/x b/x` yields the same path twice; harmless because of the Set.
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      for (let index = 1; index < match.length; index += 1) {
        const value = match[index]
        if (value) addCandidate(value, into)
      }
    }
  }
}

function addCandidate(raw: string, into: Set<string>): void {
  const value = raw.trim()
  if (!value) return
  // Patch headers often carry trailing tabs/metadata.
  const cleaned = value.split("\t")[0]?.trim() ?? ""
  if (!cleaned) return
  if (cleaned === "/dev/null") return
  if (cleaned.includes("\n") || cleaned.includes("\r")) return
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) return
  into.add(cleaned)
}

function walkInput(value: unknown, into: Set<string>, depth: number): void {
  if (value === null || value === undefined || depth > 6) return

  if (Array.isArray(value)) {
    for (const item of value) walkInput(item, into, depth + 1)
    return
  }

  if (typeof value === "string") {
    if (looksLikePatch(value)) collectPatchPaths(value, into)
    return
  }

  if (typeof value !== "object") return

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      if (PATH_KEYS.has(key.toLowerCase())) addCandidate(entry, into)
      else if (looksLikePatch(entry)) collectPatchPaths(entry, into)
      continue
    }
    walkInput(entry, into, depth + 1)
  }
}

/**
 * Candidate file paths referenced by a tool invocation.
 *
 * Deliberately permissive: callers only keep a file when its content actually
 * changed, so over-reporting is cheap while under-reporting loses undo data.
 */
export function extractPaths(tool: string, input: unknown): string[] {
  const found = new Set<string>()

  if (typeof input === "string" && looksLikePatch(input)) collectPatchPaths(input, found)
  walkInput(input, found, 0)

  // `str_replace_editor` style APIs put the payload under `str_replace`, and a
  // few tools pass the patch as a plain string argument.
  if (typeof tool === "string" && /patch/i.test(tool) && typeof input === "string") {
    collectPatchPaths(input, found)
  }

  return [...found]
}

/** Paths reported by a tool result, in whatever shape the harness used. */
export function outputPathsOf(event: unknown): string[] {
  const source = event as Record<string, unknown> | null | undefined
  if (!source) return []

  const candidates = [source.outputPaths, source.outputPath, source.output_path, source.paths]
  const found: string[] = []

  const push = (value: unknown): void => {
    if (typeof value === "string") {
      found.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) push(item)
      return
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      push(record.path ?? record.filePath ?? record.file_path ?? record.file)
    }
  }

  for (const candidate of candidates) push(candidate)
  return found.filter((value) => typeof value === "string" && value.length > 0)
}
