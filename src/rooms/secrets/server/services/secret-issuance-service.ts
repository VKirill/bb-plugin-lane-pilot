import type { LanePilotDatabase } from "../../../storage";
import { readSecretIssuance, type SecretIssuance } from "../repositories/secret-issuance-repository";

/** Returns the Env Catalog issuance journal entries of a project, newest first. */
export function listProjectSecretIssuance(db: LanePilotDatabase, projectId: string, limit = 100): SecretIssuance[] {
  return readSecretIssuance(db, projectId, limit);
}
