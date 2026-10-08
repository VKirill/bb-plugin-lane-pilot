/**
 * Runs the router evaluation (the 30 phrases of the chains spec, optionally the reserve and held-out sets) against the LIVE Jev
 * and reports accuracy, coverage (how many routes Jev decided without the helper thread), latency and tokens.
 *
 *   node_modules/.bin/tsx scripts/jev-router-eval.ts [--set core|reserve|held-out|all] [--file phrases.json] [--reverse] [--out result.json]
 *
 * `--file` replaces the sets with your own phrases: a JSON list of [phrase, expectedWorkflowId or "clarify"].
 *
 * The key is read, in order, from TYPESAFE_API_KEY / JEV_API_KEY, from `bb env-catalog get TYPESAFE_API_KEY --raw` and from
 * ~/secrets/typesafe.env. It is passed to the client and never printed. Escalated cases are answered by the deterministic scorer
 * here (there is no helper thread in a script), so three numbers are reported:
 *   decided accuracy   correct among the phrases Jev decided alone (the number the thresholds protect);
 *   end-to-end         correct among all, an escalated phrase answered by the scorer;
 *   upper bound        decided correct plus every escalated phrase, as if the helper thread were always right.
 * With --reverse each phrase is asked a second time with the candidates in reverse order (Jev leans to the first option), and
 * the report lists how many answers changed.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createJevClient, type JevClient } from "@lane-pilot/jev";
import { NONE, routeWorkflow } from "../src/jev/judgments/route-workflow";
import { choiceOf } from "@lane-pilot/jev";
import { createJev } from "@lane-pilot/jev";
import { createJevRouterModel } from "../src/jev/route-model";
import { routeIntent, scorerOutput, type RouterModel } from "../src/workflow/router";
import { publishedCatalog } from "../tests/workflow/router-catalog";
import { EVAL_SET, HELD_OUT_SET, RESERVE_SET } from "../tests/workflow/router-eval-set";

const run = promisify(execFile);

async function findKey(): Promise<string | undefined> {
  const fromEnv = (process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY)?.trim();
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await run("bb", ["env-catalog", "get", "TYPESAFE_API_KEY", "--raw"], { timeout: 20_000 });
    if (stdout.trim()) return stdout.trim();
  } catch { /* not reachable from this machine */ }
  try {
    const text = await readFile(join(homedir(), "secrets", "typesafe.env"), "utf8");
    const match = /^(?:export\s+)?(?:TYPESAFE_API_KEY|JEV_API_KEY)\s*=\s*['"]?([^'"\s]+)/m.exec(text);
    if (match) return match[1];
  } catch { /* no file */ }
  return undefined;
}

const arg = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const flag = (name: string): boolean => process.argv.includes(name);
const percentile = (values: number[], q: number): number => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0; };

type Row = { n: number; phrase: string; expected: string; by: string; got: string; ok: boolean; pick: string | null; p: number; lead: number; none: number; broad: number; ms: number; tokensIn: number };

async function main(): Promise<void> {
  const key = await findKey();
  if (!key) { console.error("no TYPESAFE_API_KEY reachable from this machine (env, bb env-catalog, ~/secrets/typesafe.env)"); process.exit(2); }
  const which = arg("--set") ?? "core";
  const phrases: Array<[number, string, string]> = [];
  if (which === "core" || which === "all") phrases.push(...EVAL_SET);
  if (which === "reserve" || which === "all") phrases.push(...RESERVE_SET.map(([phrase, id], i): [number, string, string] => [100 + i, phrase, id]));
  if (which === "held-out" || which === "all") phrases.push(...HELD_OUT_SET.map(([phrase, id], i): [number, string, string] => [200 + i, phrase, id]));
  const file = arg("--file");
  if (file) { phrases.length = 0; for (const [i, [phrase, id]] of (JSON.parse(await readFile(file, "utf8")) as Array<[string, string]>).entries()) phrases.push([300 + i, phrase, id]); }
  const reverse = flag("--reverse");

  const calls: Array<{ ms: number; tokensIn: number; tokensOut: number; ok: boolean; status?: string }> = [];
  const real = createJevClient({ apiKey: async () => key });
  const client: JevClient = {
    breaker: real.breaker,
    async call(request, options) {
      const result = await real.call(request, options);
      calls.push({ ms: result.latencyMs, tokensIn: result.ok ? result.usage.input_tokens : 0, tokensOut: result.ok ? result.usage.output_tokens : 0, ok: result.ok, ...(result.ok ? {} : { status: result.status }) });
      return result;
    },
  };
  // Both outcomes of the pick, for the report: what Jev said, whether or not the rule accepted it.
  const seen: { pick: string | null; p: number; lead: number; none: number; broad: number } = { pick: null, p: 0, lead: 0, none: 0, broad: 0 };
  const observed: JevClient = { breaker: client.breaker, call: async (request, options) => {
    const result = await client.call(request, options);
    if (result.ok) {
      const name = (id: string) => id.slice(id.indexOf("::") + 2);
      const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [name(id), answer]));
      const pick = choiceOf(answers, "pick");
      seen.pick = pick ? (pick.top === NONE ? null : pick.top) : null;
      seen.p = pick?.p ?? 0; seen.lead = pick?.margin ?? 0;
      const none = answers.pick?.type === "choice" ? answers.pick.probabilities[NONE] ?? 0 : 0;
      seen.none = none;
      seen.broad = answers.too_broad?.type === "noul" ? answers.too_broad.noul : 0;
    }
    return result;
  } };
  const instance = createJev({ client: observed });

  async function ask(phrase: string, flip: boolean): Promise<{ id: string; by: string; ms: number; tokensIn: number }> {
    let escalated = false;
    const legacy: RouterModel = async (input) => { escalated = true; return scorerOutput(input.candidates); };
    const inner = createJevRouterModel({ jev: () => instance, settings: async () => ({ "jev.modes": `${routeWorkflow.id}=active` }), legacy, projectId: "eval", runId: null });
    const model: RouterModel = (input) => inner(flip ? { ...input, candidates: [...input.candidates].reverse() } : input);
    const before = calls.length, started = Date.now();
    const decision = await routeIntent({ intent: phrase, workflows: publishedCatalog(), model });
    const used = calls.slice(before);
    const by = decision.evidence.modelFallback ? "fallback" : escalated ? "escalated" : "jev";
    return { id: decision.workflowId ?? "clarify", by, ms: Date.now() - started, tokensIn: used.reduce((sum, call) => sum + call.tokensIn, 0) };
  }

  const rows: Row[] = [];
  const flipped: string[] = [];
  for (const [n, phrase, expected] of phrases) {
    const result = await ask(phrase, false);
    rows.push({ n, phrase, expected, by: result.by, got: result.id, ok: result.id === expected, pick: seen.pick, p: Math.round(seen.p * 100) / 100, lead: Math.round(seen.lead * 100) / 100, none: Math.round(seen.none * 100) / 100, broad: Math.round(seen.broad * 100) / 100, ms: result.ms, tokensIn: result.tokensIn });
    if (reverse) {
      const second = await ask(phrase, true);
      if (second.id !== result.id) flipped.push(`${n}: ${result.id} -> ${second.id}`);
    }
  }

  const decided = rows.filter((row) => row.by === "jev"), escalated = rows.filter((row) => row.by === "escalated"), fell = rows.filter((row) => row.by === "fallback");
  const ms = decided.map((row) => row.ms), thread = 15_000;
  const meanTokens = decided.length ? decided.reduce((sum, row) => sum + row.tokensIn, 0) / decided.length : 0;
  const summary = {
    when: new Date().toISOString(), set: which, phrases: rows.length, model: "jev-latest",
    decidedByJev: decided.length, escalated: escalated.length, fallback: fell.length,
    coverage: Math.round(100 * decided.length / Math.max(1, rows.length)) / 100,
    decidedAccuracy: decided.length ? Math.round(100 * decided.filter((row) => row.ok).length / decided.length) / 100 : null,
    endToEndCorrect: rows.filter((row) => row.ok).length,
    upperBoundCorrect: decided.filter((row) => row.ok).length + escalated.length + fell.filter((row) => row.ok).length,
    latencyMs: { jevRouteP50: percentile(ms, 0.5), jevRouteP95: percentile(ms, 0.95), requestP50: percentile(calls.map((call) => call.ms), 0.5), requestP95: percentile(calls.map((call) => call.ms), 0.95) },
    tokens: { meanInputPerRoute: Math.round(meanTokens), meanOutputPerRoute: Math.round(calls.reduce((sum, call) => sum + call.tokensOut, 0) / Math.max(1, calls.length)), helperThreadInputAssumed: thread, savedPerDecidedRoute: Math.round(thread - meanTokens), savedTotal: Math.round(decided.length * (thread - meanTokens)) },
    failedRequests: calls.filter((call) => !call.ok).map((call) => call.status),
    ...(reverse ? { orderFlips: flipped } : {}),
  };
  const wrong = rows.filter((row) => !row.ok).map((row) => `${row.n}. expected ${row.expected}, got ${row.got} (${row.by}; pick ${row.pick} p ${row.p} lead ${row.lead} none ${row.none} broad ${row.broad})`);
  console.log(JSON.stringify({ summary, wrong }, null, 2));
  const out = arg("--out");
  if (out) await writeFile(out, JSON.stringify({ summary, rows }, null, 2));
}

main().catch((cause) => { console.error(cause instanceof Error ? cause.message : String(cause)); process.exit(1); });
