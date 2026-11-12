import type { LanePilotDatabase } from "../storage";
import { passportLensFor } from "./lenses";
import {
  detectPassportContradictions,
  detectPassportFluff,
  selectNextPassportQuestions,
} from "./passport-checks-and-render";
import {
  computePassportMetrics,
  createEmptyPassport,
  extractFlatPatchClaims,
  mergePassportPatch,
  type ClaimStatus,
} from "./schema";
import {
  appendVerbatim,
  decidePendingPassportDelta,
  getPassport,
  listPendingPassportDeltas,
  listVerbatim,
  upsertPassport,
} from "./store";

export const PROJECT_PASSPORT_USAGE =
  "bb lane-pilot project-passport <show|probe|set|verbatim|pending|decide> --project <id> [--role <role>] [--field <sec.key> --value <val> --status <confirmed|hypothesis|unknown|taboo>] [--verbatim <quote>] [--id <deltaId> --decision <accept|reject>] [--json]";

function argVal(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export function runProjectPassportCli(
  db: LanePilotDatabase,
  args: readonly string[],
  defaultProjectId?: string | null,
): { exitCode: number; stdout?: string; stderr?: string } {
  const sub = args[0] ?? "show";
  const projectId = argVal(args, "--project") ?? defaultProjectId ?? undefined;
  const scopeKey = argVal(args, "--scope") ?? "";
  const asJson = args.includes("--json");

  if (!projectId) {
    return { exitCode: 1, stderr: `missing --project <id>. Usage: ${PROJECT_PASSPORT_USAGE}` };
  }

  if (sub === "show") {
    const stored = getPassport(db, projectId, scopeKey);
    const role = argVal(args, "--role");
    if (!stored) {
      return {
        exitCode: 0,
        stdout: asJson
          ? JSON.stringify({ exists: false, projectId, completeness_score: 0 }, null, 2)
          : `No Living Project Passport recorded yet for ${projectId}. Start workflow "project-passport" or run \`bb lane-pilot project-passport set --project ${projectId} ...\`.\n`,
      };
    }
    const verbatim = listVerbatim(db, projectId, { scopeKey, limit: 10 });
    if (role) {
      const lens = passportLensFor(stored.passport, verbatim, { role, workflowId: argVal(args, "--workflow") });
      return { exitCode: 0, stdout: asJson ? JSON.stringify({ projectId, role, lens }, null, 2) : `${lens}\n` };
    }
    return {
      exitCode: 0,
      stdout: asJson
        ? JSON.stringify({ exists: true, ...stored, verbatim }, null, 2)
        : `${stored.passport_md}\n`,
    };
  }

  if (sub === "probe") {
    const stored = getPassport(db, projectId, scopeKey);
    const passport = stored?.passport ?? createEmptyPassport();
    const mode = argVal(args, "--mode") ?? "express";
    const domain = argVal(args, "--domain") ?? "";
    const metrics = computePassportMetrics(passport);
    const contradictions = detectPassportContradictions(passport);
    const fluff = detectPassportFluff(passport);
    const nextQuestions = selectNextPassportQuestions(passport, { mode, targetDomain: domain });
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          exists: Boolean(stored),
          projectId,
          metrics,
          contradictions,
          fluff_warnings: fluff,
          next_questions: nextQuestions,
        },
        null,
        2,
      ),
    };
  }

  if (sub === "set") {
    const field = argVal(args, "--field");
    const val = argVal(args, "--value");
    const status = (argVal(args, "--status") ?? "confirmed") as ClaimStatus;
    const quote = argVal(args, "--verbatim");
    if (!field || val === undefined) {
      return { exitCode: 1, stderr: "usage: bb lane-pilot project-passport set --project <id> --field <sec.key> --value <text> [--status confirmed|hypothesis|taboo] [--verbatim <quote>]" };
    }
    const base = getPassport(db, projectId, scopeKey)?.passport ?? createEmptyPassport();
    let evRef = "cli";
    if (quote && quote.trim()) {
      const vrb = appendVerbatim(db, {
        projectId,
        scopeKey,
        source: "cli",
        ownerVerbatim: quote,
        extractedPaths: [field],
      });
      evRef = vrb.id;
    }
    const next = mergePassportPatch(base, { [field]: { status, value: val, evidence_ref: evRef } }, { evidenceRef: evRef });
    const changed = extractFlatPatchClaims(base, next);
    const saved = upsertPassport(db, { projectId, scopeKey, passport: next, updatedBy: "cli" });
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        { ok: true, projectId, changed, completeness_score: saved.metrics.completeness_score, version: saved.version },
        null,
        2,
      ),
    };
  }

  if (sub === "verbatim") {
    const items = listVerbatim(db, projectId, { scopeKey, limit: 30 });
    return { exitCode: 0, stdout: JSON.stringify({ projectId, count: items.length, items }, null, 2) };
  }

  if (sub === "pending") {
    const items = listPendingPassportDeltas(db, projectId, scopeKey);
    return { exitCode: 0, stdout: JSON.stringify({ projectId, count: items.length, items }, null, 2) };
  }

  if (sub === "decide") {
    const deltaId = argVal(args, "--id") ?? args[1];
    const decision = (argVal(args, "--decision") ?? args[2]) as "accept" | "reject" | undefined;
    if (!deltaId || (decision !== "accept" && decision !== "reject")) {
      return { exitCode: 1, stderr: "usage: bb lane-pilot project-passport decide --project <id> --id <ppd_...> --decision <accept|reject>" };
    }
    const res = decidePendingPassportDelta(db, { projectId, deltaId, decision });
    return {
      exitCode: res.ok ? 0 : 1,
      stdout: JSON.stringify({ ok: res.ok, deltaId, decision, completeness_score: res.updated?.metrics.completeness_score }, null, 2),
    };
  }

  return { exitCode: 1, stderr: `unknown subcommand "${sub}". Usage: ${PROJECT_PASSPORT_USAGE}` };
}
