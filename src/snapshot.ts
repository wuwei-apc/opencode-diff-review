/**
 * File snapshot primitives.
 *
 * A snapshot is a complete copy of a file (text, or base64 for binary files) or
 * the knowledge that the file did not exist. Snapshots are held in memory by the
 * change tracker, which is what makes a per-file revert possible without Git.
 *
 * All I/O is synchronous on purpose: the capture hooks run inside a tool call,
 * and synchronous reads remove any ambiguity about whether the harness awaits
 * an async hook before the tool actually touches the file.
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import type { Stats } from "node:fs"
import { dirname } from "node:path"

export type FileSnapshot =
  | {
      readonly exists: true
      readonly content: string
      readonly encoding: "utf8" | "base64"
      readonly size: number
      readonly binary: boolean
    }
  | { readonly exists: false }

export const ABSENT: FileSnapshot = { exists: false }

export type ReadFailureReason = "missing" | "too-large" | "not-a-file" | "error"

export type ReadResult =
  | { readonly ok: true; readonly snapshot: FileSnapshot }
  | {
      readonly ok: false
      readonly reason: ReadFailureReason
      readonly message: string
      readonly size?: number
    }

const BINARY_PROBE_BYTES = 8192

function isBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, BINARY_PROBE_BYTES)
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string") return code
  }
  return ""
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Read a file into a snapshot, honouring the configured size ceiling. */
export function readSnapshot(absPath: string, maxBytes: number): ReadResult {
  let stats: Stats
  try {
    stats = statSync(absPath)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, snapshot: ABSENT }
    return { ok: false, reason: "error", message: errorMessage(error) }
  }

  if (!stats.isFile()) {
    return { ok: false, reason: "not-a-file", message: "目标不是普通文件" }
  }

  if (stats.size > maxBytes) {
    return {
      ok: false,
      reason: "too-large",
      message: `文件 ${stats.size} 字节，超过快照上限 ${maxBytes} 字节`,
      size: stats.size,
    }
  }

  let buffer: Buffer
  try {
    buffer = readFileSync(absPath)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: true, snapshot: ABSENT }
    return { ok: false, reason: "error", message: errorMessage(error) }
  }

  const binary = isBinaryBuffer(buffer)
  return {
    ok: true,
    snapshot: {
      exists: true,
      content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
      size: buffer.length,
      binary,
    },
  }
}

/** Write a snapshot back to disk, deleting the file when it did not exist before. */
export function restoreSnapshot(absPath: string, snapshot: FileSnapshot): void {
  if (!snapshot.exists) {
    try {
      unlinkSync(absPath)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    return
  }

  mkdirSync(dirname(absPath), { recursive: true })
  const data =
    snapshot.encoding === "base64" ? Buffer.from(snapshot.content, "base64") : snapshot.content
  writeFileSync(absPath, data)
}

export function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  if (!left.exists && !right.exists) return true
  if (!left.exists || !right.exists) return false
  return left.encoding === right.encoding && left.content === right.content
}

export function fileExists(absPath: string): boolean {
  return existsSync(absPath)
}
