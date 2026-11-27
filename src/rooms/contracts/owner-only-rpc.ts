/** RPC methods only the owner may call. The source of truth is lane-stack/hooks/guard_shell.py (_OWNER_ONLY_RPC); tests/owner-only-rpc.test.ts fails when the copies drift. */
export const OWNER_ONLY_RPC = ["specialist_autonomy_set", "charter_approve", "desk_answer", "desk_accept_defaults", "brakes_set", "manual_mode_set", "docs_set"] as const;
