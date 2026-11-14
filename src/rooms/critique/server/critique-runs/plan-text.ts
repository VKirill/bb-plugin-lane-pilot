import { isAbsolute, relative, resolve } from "node:path";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { sha256 } from "../../../tasks";
import { PLAN_INLINE_BYTES } from "../../critique";
import type { InlinedPlan } from "../../critique";

/**
 * The plan the PM hands over is often only the path of a plan file. When it is one line naming an existing file under the project, the host reads
 * it, so the critic starts from the text and the receipt can say which version was judged (sha256 of the whole file). Anything else (prose, a
 * path outside the project, a missing or unreadable file) stays as it is and is not inlined.
 */
export async function inlinePlanFile(bb: Pick<BbPluginApi, "sdk">, input: { hostId: string; projectCwd: string; plan: string }): Promise<{ inlined: InlinedPlan; sha256: string } | null> {
  const candidate = input.plan.trim();
  if (!candidate || /[\r\n]/.test(candidate) || candidate.length > 1000) return null;
  const root = resolve(input.projectCwd);
  const full = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const inside = relative(root, full);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return null;
  try {
    const file = await orMiss(Promise.resolve(bb.sdk.files.read({ hostId: input.hostId, rootPath: root, path: full })), null, isNotFound);
    if (!file || typeof file.content !== "string" || !file.content.trim()) return null;
    const bytes = Buffer.from(file.content, "utf8");
    const truncated = bytes.length > PLAN_INLINE_BYTES;
    return { inlined: { path: full, text: truncated ? bytes.subarray(0, PLAN_INLINE_BYTES).toString("utf8") : file.content, truncated }, sha256: sha256(file.content) };
  } catch { return null; }
}
