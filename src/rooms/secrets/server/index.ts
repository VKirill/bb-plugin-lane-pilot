// Public API of secrets/server: what other rooms import. Everything else in this room is private.
export { secretsRpc } from "./handlers/secrets-rpc";
export { createSecrets } from "./services/secrets-service";
export type { Secrets } from "./services/secrets-service";
export {
  ENV_CATALOG_PLUGIN,
  SECRETS_ALLOW_KEY,
  SecretsNotReadyError,
  WAITING_SECRET_PREFIX,
  allowedSecretNames,
  envForRecord,
  secretFixLines,
  secretProblem,
  waitingSecretNote,
  waitingSecretReason,
} from "../models";
export type { CatalogEntry, CatalogRecord, CredentialKind, SecretCheck, SecretResolution } from "../models";
export { room } from "./room";
