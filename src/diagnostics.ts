/**
 * Self-diagnosis.
 *
 * The v2 plugin API is beta, so the exact shape of `ctx` can differ between
 * builds. When something is missing there is no visible error: the server
 * plugin simply never registers its RPC surface, and the terminal panel can
 * only report "not connected".
 *
 * To make that debuggable, the server plugin records what it actually saw
 * during `setup` into a small JSON file in the temp dir. The TUI plugin reads
 * the same file and shows it, and it can also be inspected directly:
 *
 *   %TEMP%\opencode-diff-plugin\diag.json
 *
 * Nothing here may throw: diagnosis must never break the plugin.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function diagnosticsDir(): string {
  return join(tmpdir(), "opencode-diff-plugin")
}

export function diagnosticsPath(): string {
  return join(diagnosticsDir(), "diag.json")
}

/** CLI-side diagnostics, written when the panel cannot reach the server. */
export function tuiDiagnosticsPath(): string {
  return join(diagnosticsDir(), "tui.json")
}

export function writeTuiDiagnostics(payload: Record<string, unknown>): void {
  try {
    mkdirSync(diagnosticsDir(), { recursive: true })
    writeFileSync(
      tuiDiagnosticsPath(),
      JSON.stringify({ writtenAt: new Date().toISOString(), ...payload }, null, 2),
      "utf8",
    )
  } catch {
    // Diagnostics are best effort only.
  }
}

export function writeDiagnostics(payload: Record<string, unknown>): void {
  try {
    mkdirSync(diagnosticsDir(), { recursive: true })
    writeFileSync(
      diagnosticsPath(),
      JSON.stringify({ writtenAt: new Date().toISOString(), ...payload }, null, 2),
      "utf8",
    )
  } catch {
    // Diagnostics are best effort only.
  }
}

export function readDiagnostics(): string {
  try {
    return readFileSync(diagnosticsPath(), "utf8")
  } catch {
    return ""
  }
}

/** Enumerate an object's own and inherited property names, safely. */
export function keysOf(value: unknown): string[] {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return []
  const seen = new Set<string>()
  try {
    for (const key of Object.keys(value as object)) seen.add(key)
  } catch {
    /* ignore */
  }
  try {
    let proto = Object.getPrototypeOf(value as object)
    let depth = 0
    while (proto && proto !== Object.prototype && depth < 3) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key !== "constructor") seen.add(key)
      }
      proto = Object.getPrototypeOf(proto)
      depth += 1
    }
  } catch {
    /* ignore */
  }
  return [...seen].sort()
}
