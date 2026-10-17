/**
 * File-backed change store.
 *
 * The server plugin and the terminal UI plugin run in two different processes,
 * so they cannot share memory. Rather than depending on the (still beta) plugin
 * RPC contract, both sides simply use the same on-disk store: the server writes
 * an entry whenever an AI tool changes a file, and the panel reads, renders and
 * reverts those entries directly.
 *
 * Layout, one self-contained JSON file per changed path so that no write ever
 * has to rewrite the whole list:
 *
 *   <opencode data dir>/opencode-diff-plugin/v1/<project hash>/<path hash>.json
 *
 * Storing this outside the project keeps the working tree clean.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import type { FileSnapshot } from "./snapshot.ts"

export const STORE_VERSION = 1

export interface StoredEntry {
  version: number
  relPath: string
  sessionID: string
  /** Content before the AI first touched the file. */
  baseline: FileSnapshot
  /** False when no usable pre-image exists, which makes the file non-revertable. */
  baselineKnown: boolean
  baselineTruncated: boolean
  baselineMessage: string
  /** Content as of the last recorded tool call. */
  latest: FileSnapshot
  touches: number
  tools: string[]
  /** Cached line counts so listing stays cheap. */
  additions: number
  deletions: number
  binary: boolean
  approximate: boolean
  firstSeenAt: number
  updatedAt: number
}

export function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex")
}

/** OpenCode's data directory; `~/.local/share/opencode` on every platform we saw. */
export function resolveDataDir(): string {
  const override = process.env.OPENCODE_DATA_DIR
  if (typeof override === "string" && override.length > 0) return resolve(override)
  return join(homedir(), ".local", "share", "opencode")
}

/** Store root for one project directory. */
export function stateDirFor(projectRoot: string): string {
  const absolute = resolve(projectRoot)
  // Windows paths are case-insensitive; hash a normalised form so both processes agree.
  const normalized = process.platform === "win32" ? absolute.toLowerCase() : absolute
  return join(resolveDataDir(), "opencode-diff-plugin", `v${STORE_VERSION}`, hash(normalized).slice(0, 16))
}

export function entryFile(stateDir: string, relPath: string): string {
  return join(stateDir, `${hash(relPath)}.json`)
}

function isValidEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<StoredEntry>
  return (
    candidate.version === STORE_VERSION &&
    typeof candidate.relPath === "string" &&
    typeof candidate.baselineKnown === "boolean" &&
    typeof candidate.baseline === "object" &&
    candidate.baseline !== null &&
    typeof candidate.latest === "object" &&
    candidate.latest !== null
  )
}

export function readEntry(stateDir: string, relPath: string): StoredEntry | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(entryFile(stateDir, relPath), "utf8"))
    if (!isValidEntry(parsed)) return null
    // Guard against a hash collision or a stale file for a renamed path.
    return parsed.relPath === relPath ? parsed : null
  } catch {
    return null
  }
}

export function writeEntry(stateDir: string, entry: StoredEntry): void {
  mkdirSync(stateDir, { recursive: true })
  const target = entryFile(stateDir, entry.relPath)
  // Write then rename, so a concurrently reading process never sees half a file.
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(entry), "utf8")
  renameSync(temp, target)
}

export function deleteEntry(stateDir: string, relPath: string): boolean {
  try {
    unlinkSync(entryFile(stateDir, relPath))
    return true
  } catch {
    return false
  }
}

export function listEntries(stateDir: string): StoredEntry[] {
  let names: string[]
  try {
    names = readdirSync(stateDir)
  } catch {
    return []
  }

  const entries: StoredEntry[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(stateDir, name), "utf8"))
      if (isValidEntry(parsed)) entries.push(parsed)
    } catch {
      // A corrupt or half-written entry must not break the whole list.
    }
  }
  return entries
}

export function clearAll(stateDir: string): number {
  const entries = listEntries(stateDir)
  for (const entry of entries) deleteEntry(stateDir, entry.relPath)
  return entries.length
}

/**
 * Entries older than `maxAgeMs` are pruned so an abandoned store cannot grow
 * forever. Called opportunistically by the server on each capture.
 */
export function pruneEntries(stateDir: string, maxAgeMs: number): void {
  const now = Date.now()
  for (const entry of listEntries(stateDir)) {
    if (now - entry.updatedAt > maxAgeMs) deleteEntry(stateDir, entry.relPath)
  }
}
