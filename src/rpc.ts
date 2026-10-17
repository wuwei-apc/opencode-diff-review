/**
 * Kept only for import compatibility.
 *
 * The RPC transport was replaced by the shared file store (see `store.ts`): the
 * CLI and the server are separate processes and a store is a contract we can
 * actually rely on, whereas `client.rpc(...)` on the CLI side rejects the
 * definition with "RPC is unavailable". The payload shapes now live in
 * `types.ts`.
 */

export * from "./types.ts"
