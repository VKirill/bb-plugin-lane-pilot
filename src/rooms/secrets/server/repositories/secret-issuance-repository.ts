import { listSecretIssuance, type LanePilotDatabase, type SecretIssuance } from "../../../storage";

export type { SecretIssuance };

/** Lists Env Catalog issuance journal entries for a project, newest first. */
export function readSecretIssuance(db: LanePilotDatabase, projectId: string, limit = 100): SecretIssuance[] {
  return listSecretIssuance(db, projectId, limit);
}
