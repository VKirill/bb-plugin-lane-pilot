export type DigestLike = { send: boolean; reason: string | null; text: string; keys: string[] };
export type OwnerPushOutcome = { status: "idle" | "sent" | "dry_run" | "failed"; reason?: string };
