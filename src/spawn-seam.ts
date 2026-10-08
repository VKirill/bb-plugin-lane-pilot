export type SpawnSeamMode = "normal" | "timeout_after_ack_created" | "timeout_after_ack_not_created";

export async function spawnWithSeam<T>(
  send: () => Promise<T>,
  mode: SpawnSeamMode = "normal",
): Promise<T> {
  if (mode === "timeout_after_ack_not_created") {
    await Promise.resolve();
    throw Object.assign(new Error("synthetic timeout after transport acknowledgement (not created)"), { code:"ETIMEDOUT" });
  }
  const result = await send();
  if (mode === "timeout_after_ack_created") {
    throw Object.assign(new Error("synthetic timeout after server acknowledgement (created)"), { code:"ETIMEDOUT" });
  }
  return result;
}
