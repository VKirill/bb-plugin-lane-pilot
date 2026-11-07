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
