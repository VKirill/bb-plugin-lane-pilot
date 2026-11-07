export type SideEffects = "none" | "unknown";

export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly sideEffects: SideEffects;
  readonly next?: string;

  constructor(message: string, fields: { code: string; retryable: boolean; sideEffects: SideEffects; next?: string }) {
    super(message);
    this.name = "ToolError";
    this.code = fields.code;
    this.retryable = fields.retryable;
    this.sideEffects = fields.sideEffects;
    if (fields.next !== undefined) this.next = fields.next;
  }
}

/** A failure of the BB plugin machinery itself (a reload, a retired handle), never a task's own error. */
export const pluginStopped = (cause: unknown) => /stale API handle|generation .* is retired|plugin .* (reloaded|disabled)/i.test(cause instanceof Error ? cause.message : String(cause));
