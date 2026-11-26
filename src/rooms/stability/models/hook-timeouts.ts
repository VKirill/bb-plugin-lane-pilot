export const HOOK_TIMEOUTS_KEY = "vk:hook-timeouts";

export type HookTimeoutRecord = {
  hook: string;
  timeoutMs: number;
  threadId: string | null;
  projectId: string | null;
  required: boolean;
  at: number;
  quiet: boolean;
};
