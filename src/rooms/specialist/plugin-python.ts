import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSpPolicy, resolvePluginRoot } from "./tool-tiers";

/**
 * Plugin-owned asset & verified-script helpers for Specialist OS.
 * Lives outside `src/rooms/specialist/server/` so server modules never touch `node:fs` or `node:child_process` directly;
 * every Python invocation runs against bundled `<pluginRoot>/skills/<skill>/scripts/<script>` with `cwd: resolvePluginRoot()`.
 */
export interface BankQuestion {
  question_id: string;
  domain: "seo" | "marketing" | "specialist_os";
  target_graphs: string[];
  trigger_situation: string;
  contour: "intake_cold_start" | "pre_flight_graph" | "anomaly_reactive" | "periodic_ttl_sweep";
  question_ru: string;
  options_ru: string[];
  safe_default: string;
  impact_weight: number;
  ttl_days: number;
  periodic_reverify_query: string;
  auto_resolvable_via_mcp: boolean;
  source_citation: string;
  shadow?: boolean;
}

export interface QuestionBankFile {
  schema_version: string;
  stats: Record<string, unknown>;
  questions: BankQuestion[];
}

let cachedBank: QuestionBankFile | null = null;

export function loadQuestionBank(): QuestionBankFile {
  if (cachedBank) return cachedBank;
  const raw = readFileSync(join(resolvePluginRoot(), "policy", "questions-bank-v2.json"), "utf8");
  cachedBank = JSON.parse(raw) as QuestionBankFile;
  return cachedBank;
}

export function mergeShadowQuestions(
  base: BankQuestion[],
  shadowRawJson?: string | null,
  maxShadow = loadSpPolicy().questions.max_shadow_ext_questions,
): BankQuestion[] {
  if (!shadowRawJson || !shadowRawJson.trim()) return base;
  try {
    const parsed = JSON.parse(shadowRawJson) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { questions?: unknown[] }).questions)
        ? (parsed as { questions: unknown[] }).questions
        : [];
    const seen = new Set(base.map((q) => q.question_id));
    const extras: BankQuestion[] = [];
    for (const rawQ of arr.slice(0, maxShadow)) {
      if (!rawQ || typeof rawQ !== "object") continue;
      const q = rawQ as BankQuestion;
      if (!q.question_id || seen.has(q.question_id) || !q.question_ru) continue;
      seen.add(q.question_id);
      extras.push({ ...q, shadow: true });
    }
    return [...base, ...extras];
  } catch {
    return base;
  }
}

export function loadMergedQuestions(checkoutPath?: string | null, domain?: string): BankQuestion[] {
  const base = loadQuestionBank().questions;
  if (!checkoutPath || !domain) return base;
  const extPath = join(checkoutPath, ".agents", domain, "questions.ext.json");
  if (!existsSync(extPath)) return base;
  try {
    return mergeShadowQuestions(base, readFileSync(extPath, "utf8"));
  } catch {
    return base;
  }
}

export function hasPluginScript(skill: string, script: string): boolean {
  const root = resolvePluginRoot();
  return existsSync(join(root, "skills", skill, "scripts", script));
}

export function execPluginPythonSync(
  skill: string,
  script: string,
  cliArgs: string[],
  stdinText: string,
  timeoutMs: number,
): string {
  const root = resolvePluginRoot();
  const scriptPath = join(root, "skills", skill, "scripts", script);
  return execFileSync("python3", [scriptPath, ...cliArgs], {
    cwd: root,
    input: stdinText,
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

export async function execPluginPythonAsync(
  skill: string,
  script: string,
  cliArgs: string[],
  stdinText: string | undefined,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const root = resolvePluginRoot();
  const scriptPath = join(root, "skills", skill, "scripts", script);
  return await new Promise((resolvePromise) => {
    const child = execFile(
      "python3",
      [scriptPath, ...cliArgs],
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...(extraEnv ?? {}), PYTHONIOENCODING: "utf-8" },
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
        resolvePromise({ exitCode: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (stdinText !== undefined && child.stdin) {
      child.stdin.write(stdinText);
      child.stdin.end();
    }
  });
}
