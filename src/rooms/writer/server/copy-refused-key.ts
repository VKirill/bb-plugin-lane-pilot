import { taskFamily } from "@lane-pilot/contracts";

/** The owner-item key prefix of a refused working copy, once per reason fingerprint (sma ap_copy_refusal). */
export const copyRefusedKeyPrefix = (runId: string, taskId: string): string => `copy-refused:${runId}:${taskFamily(taskId)}:`;
