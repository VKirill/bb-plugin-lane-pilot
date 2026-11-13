import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JUDGE_OFF_FEATURES } from "../contracts";

/**
 * One chat turn through `codex exec` on this machine: the memory judge's `codex/<model>` route (the owner's Codex sign-in, no key). Lives outside
 * `server/` for the same reason as `agy-chat.ts`.
 *
 * The turn is as light as Codex lets it be (codex-cli 0.169.0: 5.9k input tokens, against 13.8k for a default `codex exec`): a dedicated
 * CODEX_HOME under `~/.lane-pilot/codex-judge` holding only a link to the owner's `auth.json` and `[features] memories = false` (HOME points
 * there too, so the owner's ~/.agents/skills and ~/.codex/AGENTS.md are not read), the judge's system text as `model_instructions_file`, every
 * tool and catalog off (JUDGE_OFF_FEATURES), `--ephemeral` (no rollout on disk, so nothing to clean up), a read-only sandbox, and the prompt on
 * stdin. The answer is the last `agent_message` of the `--json` stream. Nothing of the owner's ~/.codex is written or removed.
 * At most `MAX_PARALLEL` turns run at once; a busy slot or a missing binary is a failure the judge's fallback takes over.
 */
export type CodexTurn = { content: string; tokensIn: number; tokensOut: number };
export class CodexFailure extends Error { constructor(message: string, readonly status: number, readonly timedOut = false) { super(message); } }

const MAX_PARALLEL = 6;
const MAX_PROMPT_BYTES = 400_000;
let running = 0;

/** `LANE_PILOT_CODEX_BIN` names the binary; set to an empty string it turns the route off (the tests do, so no test runs a real model). */
export function codexBinary(home = homedir(), override = process.env.LANE_PILOT_CODEX_BIN): string | null {
  if (override !== undefined) return override && existsSync(override) ? override : null;
  for (const candidate of [join(home, ".local", "bin", "codex"), "/usr/local/bin/codex", "/opt/homebrew/bin/codex", "/usr/bin/codex"]) if (existsSync(candidate)) return candidate;
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "codex"))) return join(dir, "codex");
  return null;
}

/** The reasoning effort of a judge turn: `LANE_PILOT_CODEX_JUDGE_EFFORT` (minimal|low|medium|high), default low. */
export function codexJudgeEffort(raw = process.env.LANE_PILOT_CODEX_JUDGE_EFFORT): string {
  return raw && /^(minimal|low|medium|high|xhigh)$/.test(raw) ? raw : "low";
}

/** The judge's CODEX_HOME root (`<root>/codex` is the CODEX_HOME, the root itself is HOME); made once, holds the auth link and the instructions files. */
export function judgeHomeRoot(home = homedir()): string { return join(home, ".lane-pilot", "codex-judge"); }

export function prepareJudgeHome(root: string, authSource: string): string {
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  const auth = join(codexHome, "auth.json");
  let linked = false;
  try { linked = lstatSync(auth).isSymbolicLink(); } catch { /* absent */ }
  if (!linked && existsSync(authSource)) { try { symlinkSync(authSource, auth); } catch { /* raced by another turn */ } }
  const config = join(codexHome, "config.toml");
  if (!existsSync(config)) writeFileSync(config, "[features]\nmemories = false\n");
  return codexHome;
}

/** The `codex exec` argument list of one turn (exported for the tests). */
export function codexJudgeArgs(model: string, instructionsFile: string, effort: string, cwd: string): string[] {
  const flags = JUDGE_OFF_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]);
  return ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-C", cwd, "-m", model,
    "-c", `model_instructions_file=${JSON.stringify(instructionsFile)}`, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-c", 'web_search="disabled"',
    "-c", "agents.enabled=false", "-c", "include_permissions_instructions=false", "-c", "include_environment_context=false", ...flags, "-"];
}

/** Reads the `--json` stream: the last agent message and the turn's token usage. */
export function readCodexStream(stdout: string): { text: string | null; tokensIn: number; tokensOut: number } {
  let text: string | null = null, tokensIn = 0, tokensOut = 0;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown }; usage?: { input_tokens?: number; output_tokens?: number } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") text = event.item.text;
      if (event.type === "turn.completed") { tokensIn = event.usage?.input_tokens ?? 0; tokensOut = event.usage?.output_tokens ?? 0; }
    } catch { /* a line that is not an event */ }
  }
  return { text, tokensIn, tokensOut };
}

export function codexChat(model: string, system: string, user: string, timeoutMs: number, binary: string | null = codexBinary(), root: string = judgeHomeRoot(), authSource: string = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json")): Promise<CodexTurn> {
  if (!binary) return Promise.reject(new CodexFailure("codex not installed", 0));
  if (Buffer.byteLength(user) > MAX_PROMPT_BYTES) return Promise.reject(new CodexFailure("prompt too long for codex", 0));
  if (running >= MAX_PARALLEL) return Promise.reject(new CodexFailure("codex busy", 0));
  let codexHome: string, instructions: string;
  try {
    codexHome = prepareJudgeHome(root, authSource);
    // One file per distinct system text (content-addressed), so parallel turns never write the same path with different bytes.
    instructions = join(codexHome, `instructions-${createHash("sha256").update(system).digest("hex").slice(0, 16)}.md`);
    if (!existsSync(instructions)) writeFileSync(instructions, system);
  } catch (cause) { return Promise.reject(new CodexFailure(`codex home: ${cause instanceof Error ? cause.message : String(cause)}`, 0)); }
  running += 1;
  return new Promise<CodexTurn>((resolve, reject) => {
    const child = execFile(binary, codexJudgeArgs(model, instructions, codexJudgeEffort(), root),
      { cwd: root, env: { ...process.env, HOME: root, CODEX_HOME: codexHome }, timeout: Math.max(1, timeoutMs), maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" },
      (error: ExecFileException | null, stdout, stderr) => {
        running -= 1;
        if (error) {
          const timedOut = error.killed === true || /timed? ?out/i.test(String(error.message));
          const text = `${String(stderr)} ${error.message}`;
          return reject(new CodexFailure(text.slice(0, 300), /quota|usage limit|429|rate/i.test(text) ? 429 : 0, timedOut));
        }
        const read = readCodexStream(String(stdout));
        if (read.text === null) return reject(new CodexFailure("codex answered nothing readable", 0));
        resolve({ content: read.text, tokensIn: read.tokensIn, tokensOut: read.tokensOut });
      });
    child.stdin?.on("error", () => { /* the child exited before reading */ });
    child.stdin?.end(user);
  });
}
