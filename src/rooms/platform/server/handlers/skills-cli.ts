import { spawnAsync } from "@lane-pilot/kit";
import { filterSkillHub, formatSkillList, parseSkillHub, type SkillHub } from "../../models/skill-tree";

export async function runSkillsCli(args: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const at = (flag: string) => args.indexOf(flag);
  const sectionAt = at("--section");
  const queryAt = at("--query");
  const section = sectionAt >= 0 ? args[sectionAt + 1] : undefined;
  const query = queryAt >= 0 ? args.slice(queryAt + 1).filter((arg) => !arg.startsWith("--")).join(" ") : undefined;
  const bin = process.env.BB_CLI || "bb";
  const out = await spawnAsync(bin, ["tools", "skills-hub", "--json"], { timeout: 30_000, maxBuffer: 24_000_000 });
  if (out.error || out.status !== 0) return { exitCode: 1, stderr: `skills-hub failed: ${out.error?.message ?? out.stderr.slice(0, 200)}` };
  let hub: SkillHub;
  try {
    hub = parseSkillHub(out.stdout);
  } catch {
    return { exitCode: 1, stderr: "skills-hub returned a shape this build cannot read" };
  }
  const skills = filterSkillHub(hub, { ...(section ? { section } : {}), ...(query ? { query } : {}) });
  if (args.includes("--json")) return { exitCode: 0, stdout: JSON.stringify({ sections: hub.sections, skills }, null, 2) };
  return { exitCode: 0, stdout: formatSkillList(skills) || "no skills match" };
}
