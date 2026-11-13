// Public API of secrets/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { secretsRpc } from "./rpc/secrets";
export { SecretsNotReadyError, WAITING_SECRET_PREFIX, allowedSecretNames, createSecrets, secretFixLines, secretProblem, waitingSecretNote, waitingSecretReason } from "./secrets";
export type { CatalogEntry, SecretCheck } from "./secrets";
