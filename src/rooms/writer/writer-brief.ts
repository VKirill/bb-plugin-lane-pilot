import type { TaskV2 } from "../contracts";

/** The PM read stage's key facts for the writer; its overview repeats the task and its open questions are the PM's. */
export function pmReadBrief(pmReadContext:string):{ facts:string; openQuestions:string[] } {
  try {
    const parsed = JSON.parse(pmReadContext) as { keyFacts?:unknown; openQuestions?:unknown };
    const facts = Array.isArray(parsed.keyFacts) ? parsed.keyFacts.filter((fact):fact is string => typeof fact === "string") : null;
    const openQuestions = Array.isArray(parsed.openQuestions) ? parsed.openQuestions.filter((item):item is string => typeof item === "string") : [];
    if (facts) return { facts:facts.map((fact) => `- ${fact}`).join("\n"), openQuestions };
  } catch { /* plain text summary */ }
  return { facts:pmReadContext.trim(), openQuestions:[] };
}

/** The contract once: no empty fields, no defaults, the workspace and the read list only where the brief has them. */
export function compactContract(task:TaskV2, readListShown:boolean):Record<string, unknown> {
  const out:Record<string, unknown> = {};
  for (const [key, value] of Object.entries(task)) {
    // The PM's forecast is measured against what the writer does: the writer does not see it.
    if (key === "schema_version" || key === "project_cwd" || key === "forecast" || (key === "read_first" && readListShown)) continue;
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
    if (key === "verification" && Array.isArray(value)) {
      // `hidden:true` marks a holdout check: it runs in verification, but the writer never sees it, so it measures
      // what the contract really catches, not what the writer was told to pass (audit C9).
      const open = value.filter((command) => (command as { hidden?: boolean }).hidden !== true);
      if (!open.length) { out["verification_hidden_count"] = value.length; continue; }
      if (open.length !== value.length) out["verification_hidden_count"] = value.length - open.length;
      out[key] = open.map((command) => {
        const row = command as { command?:string; cwd?:string; timeout_sec?:number; secrets?:string[] };
        // Names of the secrets a check gets stay visible (never their values); the rest collapses to the command.
        if (row.secrets?.length) return row.cwd && row.cwd !== task.project_cwd ? row : { command:row.command, secrets:row.secrets };
        return row.cwd && row.cwd !== task.project_cwd ? row : row.command;
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

