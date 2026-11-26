import type { LanePilotDatabase } from "../../../storage";
import { pmSkillUseCounts, recordPmSkillUse } from "../services/pm-skill-use";

export function runPmSkillsCli(db: LanePilotDatabase, args: string[]): { exitCode: number; stdout?: string; stderr?: string } {
  const daysAt = args.indexOf("--days");
  const days = daysAt >= 0 ? Number(args[daysAt + 1]) : undefined;
  const rows = pmSkillUseCounts(db, { ...(days && Number.isFinite(days) ? { days } : {}) });
  if (args.includes("--json")) return { exitCode: 0, stdout: JSON.stringify({ days: days ?? 14, skills: rows }, null, 2) };
  return { exitCode: 0, stdout: rows.map((row) => `${row.skill} — ${row.uses} (${row.threads} thread${row.threads === 1 ? "" : "s"})`).join("\n") || "no PM skill calls recorded" };
}

export function runPmSkillUseCli(db: LanePilotDatabase, args: string[]): { exitCode: number; stdout?: string; stderr?: string } {
  const flagValues = new Set<number>();
  const threadAt = args.indexOf("--thread");
  const projectAt = args.indexOf("--project");
  if (threadAt >= 0) flagValues.add(threadAt + 1);
  if (projectAt >= 0) flagValues.add(projectAt + 1);
  const skill = args.find((arg, index) => !arg.startsWith("--") && !flagValues.has(index));
  const threadId = threadAt >= 0 ? args[threadAt + 1] : undefined;
  if (!skill || !threadId) return { exitCode: 1, stderr: "bb lane-pilot pm-skill-use <skill> --thread <thread-id> [--project <project-id>]" };
  recordPmSkillUse(db, { threadId, projectId: projectAt >= 0 ? args[projectAt + 1] ?? "" : "", skill });
  return { exitCode: 0, stdout: JSON.stringify({ ok: true }) };
}
