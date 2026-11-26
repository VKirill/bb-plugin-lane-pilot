import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LEAD_MD, LEAD_FILE, identityBlock, type Identity } from "./models/identity";

export { DEFAULT_LEAD_MD, LEAD_FILE, identityBlock, type Identity };

/**
 * The lead's identity (roadmap WP1): `LEAD.md` is a file the owner edits by hand in the identity folder on the hub (a mirror of his private
 * repository), never an agent. The plugin reads it at every tick and delivers it as the first block of the
 * session, and stamps the tick's receipt with its sha. The first
 * read seeds the folder with the default text, so the lead works before the owner has written a line, and the owner sees where to write.
 */
/** The identity folder: `LANE_PILOT_LEAD_DIR` when set (tests, a hub that keeps it elsewhere), else ~/.lane-pilot/lead. Read at each call so a test can point it at a temp dir. */
export const leadDir = (): string => process.env.LANE_PILOT_LEAD_DIR || join(homedir(), ".lane-pilot", "lead");

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Reads LEAD.md; writes the default when the folder is empty (once), so the owner finds the file where the docs say it is. */
export function loadIdentity(dir: string = leadDir()): Identity {
  const path = join(dir, LEAD_FILE);
  let seeded = false;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, DEFAULT_LEAD_MD, "utf8");
    seeded = true;
  }
  const text = readFileSync(path, "utf8");
  return { text, sha: sha256(text), path, seeded, bytes: Buffer.byteLength(text) };
}
