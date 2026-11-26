import { readFileSync } from "node:fs";
import { join } from "node:path";
import { literalCoverage } from "@lane-pilot/kit";
import { verdictSchema } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildCandidateEvidence,
  codeCritiquePrompt,
  codeRepairPrompt,
  critiquePrompt,
  pmReadPrompt,
  pmReadResultSchema,
  specialistPrompt,
  verifierPrompt,
  verifierVerdictSchema,
  writerRepairReplySchema,
} from "../../src/rooms/critique";
import { schemaLiterals } from "../../src/rooms/guard-tools/guard-tools";
import { qaThreadPrompt, qaVerdictSchema } from "../../src/rooms/qa/server";
import { PLAN_FACT_BRIEF_LINE, planFactRowSchema } from "../../src/rooms/tasks";

type AllowMap = Record<string, string[]>;

const ALLOW_PATH = join(__dirname, "prompt-covers-schema-allow.json");

function loadAllow(): AllowMap {
  return JSON.parse(readFileSync(ALLOW_PATH, "utf8")) as AllowMap;
}

const evidence = buildCandidateEvidence({
  produced: [],
  hashes: {},
  verification: [],
  output: "",
  ownsPaths: ["src/a.ts"],
  neverTouch: [],
  dirtOk: true,
});

const JUDGES: ReadonlyArray<{ role: string; schema: z.ZodType; buildPrompt: () => string }> = [
  {
    role: "plan-critic",
    schema: verdictSchema,
    buildPrompt: () => critiquePrompt({ plan: "plan text", task: { id: "T-1", title: "Plan task" } }),
  },
  {
    role: "code-critic",
    schema: verdictSchema,
    buildPrompt: () => codeCritiquePrompt({ evidence, task: { id: "T-1", title: "Code task" } }),
  },
  {
    role: "specialist-reviewer",
    schema: verdictSchema,
    buildPrompt: () => specialistPrompt({ task: { id: "T-1", title: "Specialist task" }, plan: "plan text" }),
  },
  {
    role: "code-verifier",
    schema: z.object({ verdicts: z.array(verifierVerdictSchema) }),
    buildPrompt: () => verifierPrompt({
      findings: [{ id: "f1", severity: "blocking", finding: "issue", criterion: "safety", path: "src/a.ts", evidence: "x" }],
      task: { id: "T-1", title: "Verifier task" },
    }),
  },
  {
    role: "browser-qa",
    schema: qaVerdictSchema,
    buildPrompt: () => qaThreadPrompt({
      url: "http://127.0.0.1:3000",
      cases: ["page renders"],
      viewports: "375",
      envClass: "dev",
      authorized: false,
      qaHostId: "host-1",
    }),
  },
  {
    role: "pm-reader",
    schema: pmReadResultSchema,
    buildPrompt: () => pmReadPrompt({ task: { id: "T-1", title: "PM read", goal: "Understand target", read_first: [] } }),
  },
  {
    role: "code-repair",
    schema: writerRepairReplySchema,
    buildPrompt: () => codeRepairPrompt({
      task: { id: "T-1", title: "Repair task", owns_paths: ["src/a.ts"], never_touch: [], verification: [] },
      findings: [],
      agent: "Lane Pilot writer",
      setupLines: ["setup"],
      contextBlocks: ["context"],
    }),
  },
  {
    role: "plan-fact",
    schema: planFactRowSchema,
    buildPrompt: () => PLAN_FACT_BRIEF_LINE,
  },
];

function checkPromptCoverage(schema: z.ZodType, prompt: string, allowed: readonly string[] = []) {
  const literals = schemaLiterals(schema);
  const coverage = literalCoverage(literals, prompt);
  const unexpected = coverage.missing.filter((literal) => !allowed.includes(literal));
  const staleAllow = allowed.filter((literal) => !coverage.missing.includes(literal));
  return { literals, missing: coverage.missing, unexpected, staleAllow };
}

describe("every judge prompt covers its Zod schema literals", () => {
  it("extracts enum members, consts and required keys dynamically via schemaLiterals", () => {
    const literals = schemaLiterals(verdictSchema);
    expect(literals).toEqual(expect.arrayContaining(["pass", "rework", "block", "critical", "high", "medium", "low", "info", "ok", "fail", "status", "findings", "evidence", "file", "severity", "id", "result"]));
  });

  it("checks every judge's real prompt against its schema literals and prints prompt.coverage", () => {
    const allow = loadAllow();
    for (const judge of JUDGES) {
      const allowed = allow[judge.role] ?? [];
      const result = checkPromptCoverage(judge.schema, judge.buildPrompt(), allowed);
      console.log(`prompt.coverage role=${judge.role} missing=${JSON.stringify(result.missing)}`);
      expect(result.unexpected, `${judge.role} missing literals not in allow-file`).toEqual([]);
      expect(result.staleAllow, `${judge.role} allow-file can shrink; remove resolved literals`).toEqual([]);
    }
    const unknownRoles = Object.keys(allow).filter((role) => !JUDGES.some((judge) => judge.role === role));
    expect(unknownRoles, "stale roles in prompt-covers-schema-allow.json").toEqual([]);
  });

  it("fails naming the missing enum member when removed from a judge prompt", () => {
    const prompt = JUDGES[0]!.buildPrompt();
    const stripped = prompt.replace(/\brework\b/g, "other");
    const result = checkPromptCoverage(JUDGES[0]!.schema, stripped);
    expect(result.unexpected).toContain("rework");
  });
});
