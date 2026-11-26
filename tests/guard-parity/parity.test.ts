import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { useGuardPool, type Verdict } from "../guard-pool";
import { runOracleBatch } from "./oracle";

type CorpusRow = { id: string; class: string; command: string; role?: string };
type KnownGapsFile = {
  gaps: Array<{ id: string; class: string; reason: string }>;
  p2Baseline: number;
  replay30dBudget: number;
};

const ROOT = join(__dirname, "../..");
const GUARD_PATH = join(ROOT, "lane-stack/hooks/guard_shell.py");
const CORPUS_PATH = join(__dirname, "corpus.jsonl");
const GAPS_PATH = join(__dirname, "known-gaps.json");

function loadCorpusJsonl(): CorpusRow[] {
  const lines = readFileSync(CORPUS_PATH, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.map((line) => JSON.parse(line) as CorpusRow);
}

/** Extracts static command strings from existing tests/guard*.test.ts tables without re-running their suites. */
function loadExistingGuardTestCommands(): CorpusRow[] {
  const testFiles = readdirSync(join(ROOT, "tests"))
    .filter((name) => /^guard.*\.test\.ts$/.test(name))
    .sort();
  const out: CorpusRow[] = [];
  const seen = new Set<string>();
  const add = (file: string, command: string) => {
    const trimmed = command.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ id: `existing:${file}:${out.length + 1}`, class: "existing-guard-tests", command: trimmed, role: "writer" });
  };
  const strOf = (node: ts.Expression): string | null =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;

  for (const file of testFiles) {
    const text = readFileSync(join(ROOT, "tests", file), "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          const name = ts.isIdentifier(decl.name) ? decl.name.text : "";
          if (!decl.initializer) continue;
          if (/^(STRICT_DENIED|STRICT_ONLY|FORMS)$/.test(name) && ts.isArrayLiteralExpression(decl.initializer)) {
            for (const el of decl.initializer.elements) {
              if (ts.isArrayLiteralExpression(el) && el.elements.length >= 2) {
                const cmd = strOf(el.elements[1]!);
                if (cmd) add(file, cmd);
              }
            }
          } else if (/^(STRICT_ALLOWED|OPEN|PM_ALLOWED)$/.test(name) && ts.isArrayLiteralExpression(decl.initializer)) {
            for (const el of decl.initializer.elements) {
              const cmd = strOf(el);
              if (cmd) add(file, cmd);
            }
          } else if (/^(cases|pmFileCases)$/.test(name) && ts.isArrayLiteralExpression(decl.initializer)) {
            for (const el of decl.initializer.elements) {
              if (ts.isCallExpression(el) && ts.isIdentifier(el.expression) && el.expression.text === "bash" && el.arguments.length >= 2) {
                const cmd = strOf(el.arguments[1]!);
                if (cmd) add(file, cmd);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

type GuardVerdictKind = "deny" | "refuse" | "allow";

function classifyGuardVerdict(verdict: Verdict): GuardVerdictKind {
  if (verdict.status === 0) return "allow";
  if (/\[lane-pilot-guard\]\s*unreadable:/i.test(verdict.stdout)) return "refuse";
  return "deny";
}

const payloadOf = (command: string, agentType: string | null) =>
  JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp", ...(agentType ? { agent_type: agentType } : {}) });

const runMany = useGuardPool(GUARD_PATH, payloadOf);

describe("shell guard parity oracle", () => {
  const jsonlCases = loadCorpusJsonl();
  const existingCases = loadExistingGuardTestCommands();
  const allCases: CorpusRow[] = [...jsonlCases, ...existingCases];

  it("corpus has at least 200 cases plus existing guard test commands", () => {
    expect(jsonlCases.length).toBeGreaterThanOrEqual(200);
    expect(existingCases.length).toBeGreaterThan(20);
  });

  it("P1 safety & gap ratchet: no allowed case ran a protected argv outside known-gaps.json, and no closed gap stays listed", async () => {
    const known = JSON.parse(readFileSync(GAPS_PATH, "utf8")) as KnownGapsFile;
    const knownMap = new Map(known.gaps.map((g) => [g.id, g]));

    const [oracleResults, guardVerdicts] = await Promise.all([
      runOracleBatch(allCases),
      runMany(allCases.map((c) => ({ command: c.command, agentType: c.role ?? "writer" }))),
    ]);

    const unlistedBypasses: Array<{ id: string; class: string; command: string; argvs: string[][] }> = [];
    const closedListedGaps: string[] = [];
    const p2Misses: Array<{ id: string; class: string; guard: GuardVerdictKind; command: string }> = [];

    allCases.forEach((c, idx) => {
      const oracle = oracleResults.get(c.id)!;
      const guard = classifyGuardVerdict(guardVerdicts[idx]!);
      const oracleState = oracle.protectedRan ? "ran" : "none";
      console.debug(`guard.parity id=${c.id} oracle=${oracleState} guard=${guard}`);

      if (oracle.protectedRan && guard === "allow") {
        if (!knownMap.has(c.id)) {
          unlistedBypasses.push({
            id: c.id,
            class: c.class,
            command: c.command,
            argvs: oracle.protectedArgvs.map((p) => p.argv),
          });
        }
      } else if (knownMap.has(c.id)) {
        closedListedGaps.push(c.id);
      }

      if (!oracle.protectedRan && guard !== "allow") {
        p2Misses.push({ id: c.id, class: c.class, guard, command: c.command });
      }
    });

    const corpusIds = new Set(allCases.map((c) => c.id));
    for (const g of known.gaps) {
      if (!corpusIds.has(g.id)) closedListedGaps.push(`${g.id} (missing from corpus)`);
    }

    expect(unlistedBypasses, "unlisted P1 bypasses where real shell ran protected argv but guard allowed").toEqual([]);
    expect(closedListedGaps, "closed gaps still listed in known-gaps.json — remove them").toEqual([]);
    expect(p2Misses.length, `P2 misses exceeded baseline (${known.p2Baseline}): ${JSON.stringify(p2Misses)}`).toBeLessThanOrEqual(known.p2Baseline);
  }, 120_000);

  it("replay of last 30 days of writer Bash commands keeps refusals under budget (when local transcripts exist)", async () => {
    const projectsDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projectsDir)) return;
    const cutoff = Date.now() - 30 * 86_400_000;
    const cmds: string[] = [];
    for (const dir of readdirSync(projectsDir)) {
      if (!dir.includes("lpattempt")) continue;
      const fullDir = join(projectsDir, dir);
      if (!statSync(fullDir).isDirectory()) continue;
      for (const name of readdirSync(fullDir)) {
        if (!name.endsWith(".jsonl")) continue;
        const fullFile = join(fullDir, name);
        if (statSync(fullFile).mtimeMs < cutoff) continue;
        const lines = readFileSync(fullFile, "utf8").split("\n");
        for (const line of lines) {
          if (!line.includes('"Bash"')) continue;
          try {
            const obj = JSON.parse(line) as { message?: { content?: Array<{ type?: string; name?: string; input?: { command?: string } }> } };
            const content = obj.message?.content;
            if (!Array.isArray(content)) continue;
            for (const block of content) {
              if (block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string" && block.input.command.trim()) {
                cmds.push(block.input.command);
              }
            }
          } catch { /* malformed transcript line */ }
        }
      }
    }
    if (!cmds.length) return;
    const known = JSON.parse(readFileSync(GAPS_PATH, "utf8")) as KnownGapsFile;
    const verdicts = await runMany(cmds.map((command) => ({ command, agentType: "writer" })));
    const blocked = verdicts
      .map((v, idx) => ({ verdict: classifyGuardVerdict(v), command: cmds[idx]! }))
      .filter((r) => r.verdict !== "allow");
    expect(blocked.length, `30-day replay blocked ${blocked.length} commands > budget ${known.replay30dBudget}`).toBeLessThanOrEqual(known.replay30dBudget);
  }, 120_000);
});
