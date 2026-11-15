import { isAbsolute, relative, resolve } from "node:path";
import { isNotFound, orMiss, sha256Hex } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * The plan the PM hands over is often only the path of a plan file. A path-shaped single line naming a file under the
 * project is read WHOLE and verified against the SDK's own sha256/sizeBytes before it counts as the plan: a truncated
 * or unverifiable read is a named failure, never a hashed prefix passed off as the whole file. Prose (any line with
 * whitespace that is not path-shaped) stays null — the caller treats the plan parameter itself as the plan text.
 */

export class PlanFileError extends Error {
  constructor(readonly code: "plan_path_outside_project" | "plan_file_unreadable" | "plan_file_encoding" | "plan_file_unverifiable" | "plan_file_truncated" | "plan_file_hash_mismatch", detail: string) {
    super(`${code}:${detail}`);
    this.name = "PlanFileError";
  }
}

/** Path-shaped means: one line, no whitespace, and either absolute, dot-relative, contains a slash, or ends in an extension. Prose with spaces never qualifies. */
function planPathCandidate(plan: string): string | null {
  const candidate = plan.trim();
  if (!candidate || candidate.length > 1000 || /\s/.test(candidate)) return null;
  if (!(isAbsolute(candidate) || candidate.startsWith(".") || candidate.includes("/") || /\.[A-Za-z0-9]{1,10}$/.test(candidate))) return null;
  return candidate;
}

export async function readPlanFile(bb: Pick<BbPluginApi, "sdk">, input: { hostId: string; projectCwd: string; plan: string }): Promise<{ path: string; text: string; sha256: string } | null> {
  const candidate = planPathCandidate(input.plan);
  if (!candidate) return null;
  const root = resolve(input.projectCwd);
  const full = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const inside = relative(root, full);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new PlanFileError("plan_path_outside_project", candidate);
  let file: unknown;
  try {
    file = await orMiss(Promise.resolve(bb.sdk.files.read({ hostId: input.hostId, rootPath: root, path: full })), null, isNotFound);
  } catch (cause) {
    throw new PlanFileError("plan_file_unreadable", cause instanceof Error ? cause.message : String(cause));
  }
  const rec = file && typeof file === "object" ? file as { content?: unknown; contentEncoding?: unknown; sha256?: unknown; sizeBytes?: unknown } : null;
  if (!rec || typeof rec.content !== "string" || !rec.content.trim()) throw new PlanFileError("plan_file_unreadable", full);
  if (rec.contentEncoding !== undefined && rec.contentEncoding !== "utf8" && rec.contentEncoding !== "base64") throw new PlanFileError("plan_file_encoding", String(rec.contentEncoding));
  const raw = rec.contentEncoding === "base64" ? Buffer.from(rec.content, "base64") : Buffer.from(rec.content, "utf8");
  const text = raw.toString("utf8");
  // Wholeness is proven by the SDK's own size/hash when it reports them; a read that reports neither cannot be told
  // from a truncated one, so it is refused rather than hashed as if it were the whole plan.
  const hasSize = typeof rec.sizeBytes === "number";
  const hasSha = typeof rec.sha256 === "string" && /^[0-9a-f]{64}$/i.test(rec.sha256);
  if (!hasSize && !hasSha) throw new PlanFileError("plan_file_unverifiable", full);
  if (hasSize && raw.length !== rec.sizeBytes) throw new PlanFileError("plan_file_truncated", `${full}:${raw.length}!=${rec.sizeBytes}`);
  const sha256 = hasSha ? String(rec.sha256).toLowerCase() : sha256Hex(text);
  if (hasSha && sha256Hex(text) !== sha256) throw new PlanFileError("plan_file_hash_mismatch", full);
  return { path: full, text, sha256 };
}
