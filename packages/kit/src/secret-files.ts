/**
 * Which repo-relative paths look like secrets: a folder that holds keys or a file named like one. One list for every
 * reader of project files (the work-file window, the file-card catalog) so they refuse the same names. No imports: the
 * session hook runs this as plain source.
 */
export const SECRET_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);
// Names only, not a substring of «key»: keyboard.ts and keys.ts are code, id_rsa and credentials.json are not.
export const SECRET_NAMES = [/^\.env/i, /\.(pem|key|p12|pfx)$/i, /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i, /^\.(npmrc|netrc|pgpass)$/i, /^(credentials|secret)/i, /token.*\.(txt|json)$/i];

/** Why a path counts as secret, or null: the secret folder it sits in, or `name` when its file name is secret-looking. */
export function secretPathHit(relativePath: string): { dir: string } | { name: true } | null {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const dir = parts.find((part) => SECRET_DIRS.has(part));
  if (dir) return { dir };
  return SECRET_NAMES.some((pattern) => pattern.test(parts[parts.length - 1] ?? "")) ? { name: true } : null;
}
