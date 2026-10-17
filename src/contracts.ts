/**
 * Minimal structural contracts for the OpenCode v2 plugin contexts we depend on.
 *
 * The v2 plugin API is documented as beta, so instead of relying on the exact
 * exported types we declare the small surface this plugin actually uses and
 * cast to it once, at the plugin boundary. Every call site then uses optional
 * chaining so a renamed or missing capability degrades into a clear log message
 * instead of crashing the whole OpenCode process.
 */

/** Event object handed to `ctx.tool.hook("execute.before" | "execute.after")`. */
export interface ToolHookEvent {
  /** Selected tool name, e.g. `write`, `edit`, `patch`. */
  readonly tool?: string
  /** Tool arguments. Mutable in `execute.before`. */
  input?: unknown
  /** Paths the tool reports it wrote to. Available in `execute.after`. */
  readonly outputPaths?: unknown
  /** Present when the tool failed. */
  readonly error?: unknown
  readonly sessionID?: string
  readonly callID?: string
  readonly messageID?: string
  readonly [key: string]: unknown
}

export interface HookRegistration {
  dispose?: () => void | Promise<void>
}

export interface RpcHandlerContext {
  readonly signal?: AbortSignal
  /** Produce a declared RPC error instead of throwing. */
  readonly error?: (type: string, message: string, data?: unknown) => unknown
}

export type RpcHandler = (
  input: unknown,
  context: RpcHandlerContext,
) => unknown | Promise<unknown>

export interface RpcRegistration {
  events?: {
    emit?: (name: string, data: unknown) => unknown | Promise<unknown>
  }
  dispose?: () => void | Promise<void>
}

/** Server-side plugin context (`Plugin.define({ setup })` from `@opencode/plugin`). */
export interface ServerPluginContext {
  readonly location?: {
    readonly directory?: string
    readonly project?: { readonly id?: string; readonly directory?: string }
  }
  readonly options?: Record<string, unknown>
  readonly app?: { readonly version?: string }
  tool?: {
    hook?: (
      name: string,
      callback: (event: ToolHookEvent) => unknown,
    ) => Promise<HookRegistration> | HookRegistration
  }
  rpc?: {
    register?: (
      definition: unknown,
      implementation: Record<string, RpcHandler>,
    ) => Promise<RpcRegistration> | RpcRegistration
  }
}

/* -------------------------------------------------------------------------- */
/* Terminal UI                                                                */
/* -------------------------------------------------------------------------- */

export interface DialogOption {
  title: string
  value: string
  description?: string
  disabled?: boolean
  category?: string
}

export interface DialogSelectInput {
  title?: string
  current?: string
  options: DialogOption[]
  search?: unknown
}

export interface DialogAction {
  bind?: string
  title: string
  side?: "left" | "right"
  selection?: "selected" | "none"
  onTrigger?: (value: string) => unknown
}

export interface KeymapCommand {
  id: string
  title: string
  group?: string
  bind?: string
  palette?: boolean
  suggested?: boolean
  slash?: { name: string; aliases?: string[]; arguments?: boolean }
  enabled?: () => boolean
  run: (input?: string) => unknown
}

export interface KeymapLayer {
  mode?: string
  priority?: number
  commands: KeymapCommand[]
  bindings?: string[]
}

export interface TuiToast {
  title?: string
  message?: string
  variant?: "info" | "success" | "warning" | "error"
  duration?: number
}

/** RPC subclient produced by `context.client.rpc(definition)`. */
export interface RpcSubclient {
  events?: {
    on?: (name: string, callback: (event: unknown) => void) => () => void
  }
  [method: string]: unknown
}

/** CLI-side plugin context (`Plugin.define({ setup })` from `@opencode/plugin/tui`). */
export interface TuiPluginContext {
  readonly options?: Record<string, unknown>
  readonly location?: { readonly directory?: string }
  readonly app?: { readonly version?: string; readonly channel?: string }
  client?: { rpc?: (definition: unknown) => RpcSubclient }
  ui?: {
    toast?: { show?: (toast: TuiToast) => unknown }
    dialog?: {
      select?: (input: DialogSelectInput) => Promise<string | undefined>
      confirm?: (input: {
        title?: string
        message?: string
        label?: { confirm?: string; cancel?: string }
      }) => Promise<boolean>
      alert?: (input: { title?: string; message?: string }) => Promise<unknown>
      prompt?: (input: { title?: string; placeholder?: string }) => Promise<string | undefined>
      clear?: () => void
      set?: (input: { size?: string; centered?: boolean }) => unknown
    }
  }
  keymap?: {
    layer?: (factory: () => KeymapLayer) => unknown
    dispatch?: (id: string, input?: string) => unknown
  }
  data?: unknown
  theme?: unknown
}
