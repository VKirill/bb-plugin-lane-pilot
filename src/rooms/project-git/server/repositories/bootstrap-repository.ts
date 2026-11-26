import { bootstrapKey, declinedKey, type BootstrapRecord, type SavedScope } from "../../models/bootstrap";

export type Kv = {
  get<T>(key: string): Promise<T | null | undefined>;
  set(key: string, value: never): Promise<unknown>;
};

export const getBootstrapRecord = (kv: Kv, hostId: string, root: string) =>
  kv.get<BootstrapRecord>(bootstrapKey(hostId, root));

export const saveBootstrapRecord = (kv: Kv, hostId: string, root: string, rec: BootstrapRecord) =>
  kv.set(bootstrapKey(hostId, root), rec as never);

export const getSavedScope = (kv: Kv, key: string) =>
  kv.get<SavedScope>(key);

export const saveScope = (kv: Kv, key: string, scope: SavedScope) =>
  kv.set(key, scope as never);

export const isTaskDeclined = async (kv: Kv, taskKey: string) =>
  Boolean(await kv.get<string>(declinedKey(taskKey)));

export const markTaskDeclined = (kv: Kv, taskKey: string, reason: string) =>
  kv.set(declinedKey(taskKey), reason as never);
