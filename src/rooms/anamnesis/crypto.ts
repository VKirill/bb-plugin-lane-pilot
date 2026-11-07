import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Field-level encryption of the owner anamnesis on the hub (M1b). Only records whose sensitivity is `sensitive`
 * carry ciphertext; the wire format is self-describing — `v1:<iv b64>:<tag b64>:<data b64>` — so a reader decrypts
 * any value that starts with `v1:` and passes everything else through (the legacy file store stays plaintext).
 * The key is `LP_OWNER_MEMORY_KEY` from Env Catalog: base64 of exactly 32 bytes, fetched on the hub.
 */
export const OWNER_KEY_NAME = "LP_OWNER_MEMORY_KEY";

export class OwnerKeyError extends Error {
  constructor(message: string) { super(message); this.name = "OwnerKeyError"; }
}

/** The catalog value as a 32-byte key, or null when it is absent or malformed (never a partial key). */
export function parseOwnerKey(value: string | null | undefined): Buffer | null {
  if (!value) return null;
  // Buffer.from(base64) never throws on bad input — it decodes what it can; the length check is the whole validation.
  const key = Buffer.from(value.trim(), "base64");
  return key.length === 32 ? key : null;
}

export function encryptOwnerField(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

/** `v1:` ciphertext opens with the key; anything else is already plaintext. Throws OwnerKeyError when the key is missing or wrong. */
export function decryptOwnerField(key: Buffer | null, value: string): string {
  if (!value.startsWith("v1:")) return value;
  if (!key) throw new OwnerKeyError("owner_key_missing: LP_OWNER_MEMORY_KEY is not available, sensitive records stay closed");
  const parts = value.split(":");
  if (parts.length !== 4) throw new OwnerKeyError("owner_key_invalid: malformed ciphertext");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1]!, "base64"));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64")), decipher.final()]).toString("utf8");
  } catch (cause) {
    if (cause instanceof OwnerKeyError) throw cause;
    throw new OwnerKeyError(`owner_key_invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
