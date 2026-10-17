/**
 * Server entrypoint for `opencode-diff-plugin`.
 *
 * OpenCode v2 loads a plugin directory by looking for `index.ts` (server) and
 * `tui.ts` (terminal UI) next to each other, so this file only re-exports the
 * implementation from `src/`.
 */
export { default } from "./src/server.ts"
