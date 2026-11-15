// Public API of contracts/ui: browser-safe schemas the UI imports. Everything else in this room is private.
// Kept apart from the room's domain index on purpose: that index pulls the server RPC contract (Node builtins),
// while these schemas are zod-only and must stay importable from the browser bundle.
export * from "../ui-query-schemas";
