/**
 * Whether a text is about secrets or the environment (an `.env` file, the Env Catalog, an API key, a token, a private
 * key) or had a secret redacted from it. The router reads it to keep such a text away from the Jev API.
 */
const SENSITIVE = /\.env\b|env[_ -]?catalog|\benv_(?:get|set|list|request)|printenv|process\.env|BEGIN [A-Z ]*PRIVATE KEY|\b[A-Za-z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]|\bBearer\s+[A-Za-z0-9._~+/-]{12,}|\bAuthorization:|\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}/i;
export const looksSensitive = (raw: string, redacted: string): boolean => raw !== redacted || SENSITIVE.test(redacted);
