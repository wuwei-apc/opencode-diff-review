/**
 * Terminal UI entrypoint for `opencode-diff-plugin`.
 *
 * Imported by the CLI process, separately from the server plugin. It talks to
 * the server plugin over its RPC contract (see `src/rpc.ts`).
 */
export { default } from "./src/tui.ts"
