/**
 * Server-side plugin: captures a pre-image of every file an AI tool touches and
 * records the change into the shared file store.
 *
 * It registers no model-facing tools and no RPC surface. The terminal panel is a
 * separate process that reads the same store directly, which keeps the plugin
 * independent of the still-beta plugin RPC contract.
 */

import { resolve } from "node:path"

import { Plugin } from "@opencode/plugin"

import type { ServerPluginContext, ToolHookEvent } from "./contracts.ts"
import { keysOf, writeDiagnostics } from "./diagnostics.ts"
import { positiveInteger, readTrackerOptions } from "./options.ts"
import { outputPathsOf, toRelative } from "./paths.ts"
import { runSelfTest } from "./selftest.ts"
import { stateDirFor } from "./store.ts"
import { ChangeTracker } from "./tracker.ts"
import type { PreCapture } from "./tracker.ts"

const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000
const MAX_PENDING = 500

interface PendingCapture {
  pre: PreCapture
  at: number
}

function readOptions(raw: Record<string, unknown> | undefined): {
  maxFileBytes: number
  contextLines: number
  maxLines: number
  trackTools: string[]
  pendingTTLMs: number
} {
  const tracker = readTrackerOptions(raw)
  return {
    ...tracker,
    pendingTTLMs: positiveInteger(raw?.pendingTTLMs, DEFAULT_PENDING_TTL_MS),
  }
}

function resolveRoot(context: ServerPluginContext): string {
  const directory = context.location?.directory ?? context.location?.project?.directory
  if (typeof directory === "string" && directory.length > 0) return resolve(directory)
  return resolve(process.cwd())
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}

/** Drop stale entries so abandoned tool calls cannot grow the map forever. */
function prunePending(pending: Map<string, PendingCapture>, ttlMs: number): void {
  const now = Date.now()
  for (const [key, value] of pending) {
    if (now - value.at > ttlMs) pending.delete(key)
  }

  if (pending.size <= MAX_PENDING) return

  const ordered = [...pending.entries()].sort((left, right) => left[1].at - right[1].at)
  const excess = pending.size - MAX_PENDING
  for (let index = 0; index < excess; index += 1) {
    const oldest = ordered[index]
    if (oldest) pending.delete(oldest[0])
  }
}

export default Plugin.define({
  id: "opencode.diff.tracker",

  async setup(rawContext: unknown) {
    const context = rawContext as ServerPluginContext
    const root = resolveRoot(context)
    const options = readOptions(context.options)
    const stateDir = stateDirFor(root)

    // Record what this build actually exposes, so a failed load is diagnosable
    // without access to the server log.
    const diag: Record<string, unknown> = {
      stage: "setup:start",
      plugin: "opencode.diff.tracker",
      root,
      stateDir,
      opencode: context.app?.version ?? "unknown",
      contextKeys: keysOf(context),
      hasToolHook: typeof context.tool?.hook === "function",
    }
    writeDiagnostics(diag)

    const tracker = new ChangeTracker({
      root,
      stateDir,
      maxFileBytes: options.maxFileBytes,
      contextLines: options.contextLines,
      maxLines: options.maxLines,
      trackTools: options.trackTools,
    })

    const pending = new Map<string, PendingCapture>()
    let sessionID = ""

    const rememberSession = (event: ToolHookEvent): void => {
      const value = typeof event.sessionID === "string" ? event.sessionID : ""
      if (value.length > 0) sessionID = value
    }

    const before = (event: ToolHookEvent): void => {
      try {
        rememberSession(event)
        const targets = tracker.candidatePaths(event.tool ?? "", event.input)
        if (targets.length === 0) return

        prunePending(pending, options.pendingTTLMs)
        for (const relPath of targets) {
          // First write wins: an earlier pre-image is the better revert target.
          if (pending.has(relPath)) continue
          pending.set(relPath, { pre: tracker.captureBaseline(relPath), at: Date.now() })
        }
      } catch (error) {
        console.warn(`[opencode-diff] 采集修改前内容失败：${describe(error)}`)
      }
    }

    const after = (event: ToolHookEvent): void => {
      try {
        rememberSession(event)

        const targets = new Set<string>()
        for (const relPath of tracker.candidatePaths(event.tool ?? "", event.input)) {
          targets.add(relPath)
        }
        for (const raw of outputPathsOf(event)) {
          const relPath = toRelative(root, raw)
          if (relPath) targets.add(relPath)
        }
        if (targets.size === 0) return

        for (const relPath of targets) {
          const captured = pending.get(relPath)
          pending.delete(relPath)
          tracker.recordAfter({
            relPath,
            tool: event.tool ?? "unknown",
            sessionID,
            pre: captured?.pre,
          })
        }
      } catch (error) {
        console.warn(`[opencode-diff] 记录修改后内容失败：${describe(error)}`)
      }
    }

    const hook = context.tool?.hook
    if (typeof hook !== "function") {
      diag.hooksRegistered = false
      console.warn("[opencode-diff] 当前 OpenCode 版本不提供 ctx.tool.hook，插件无法采集 AI 变更")
    } else {
      try {
        await hook.call(context.tool, "execute.before", before)
        await hook.call(context.tool, "execute.after", after)
        diag.hooksRegistered = true
      } catch (error) {
        diag.hooksRegistered = false
        diag.hooksError = describe(error)
        console.warn(`[opencode-diff] 注册工具钩子失败：${describe(error)}`)
      }
    }

    // Prove the capture/revert engine works in *this* runtime, not just that the
    // modules imported. Runs against a scratch dir in temp.
    try {
      diag.selfTest = runSelfTest()
    } catch (error) {
      diag.selfTest = { ok: false, steps: [{ name: "selfTest", ok: false, detail: describe(error) }] }
    }

    diag.stage = "ready"
    writeDiagnostics(diag)
    console.log(
      `[opencode-diff] 已启用，跟踪目录 ${root}（自检 ${(diag.selfTest as { ok?: boolean }).ok ? "通过" : "未通过"}）`,
    )

    return () => {
      pending.clear()
    }
  },
})
