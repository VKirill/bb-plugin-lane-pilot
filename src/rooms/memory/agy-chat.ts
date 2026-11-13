import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One chat turn through the Antigravity CLI (`agy -p`) on this machine: the memory judge's `agy/<model>` route (Gemini on the owner's
 * Antigravity sign-in, no key, no money). Lives outside `server/` so server modules never touch `node:child_process` or `node:fs`.
 *
 * `agy` keeps every turn as a conversation on disk (~0.5 MB each); the judge's turns are throwaway, so the conversation and its brain folder
 * are removed as soon as the answer is read. At most `MAX_PARALLEL` turns run at once; a busy slot or a missing binary is a failure the judge's
 * fallback takes over.
 */
export type AgyTurn = { content: string; tokensIn: number; tokensOut: number };
export class AgyFailure extends Error { constructor(message: string, readonly status: number, readonly timedOut = false) { super(message); } }

const MAX_PARALLEL = 3;
/** Linux keeps one argv string under 128 KiB; a longer prompt goes to the fallback instead. */
const MAX_PROMPT_BYTES = 100_000;
let running = 0;

/** `LANE_PILOT_AGY_BIN` names the binary; set to an empty string it turns the route off (the tests do, so no test runs a real model). */
export function agyBinary(home = homedir(), override = process.env.LANE_PILOT_AGY_BIN): string | null {
  if (override !== undefined) return override && existsSync(override) ? override : null;
  for (const candidate of [join(home, ".local", "bin", "agy"), "/usr/local/bin/agy", "/opt/homebrew/bin/agy"]) if (existsSync(candidate)) return candidate;
  return null;
}

function forget(conversationId: string, home = homedir()): void {
  if (!/^[0-9a-f-]{36}$/.test(conversationId)) return;
  const root = join(home, ".gemini", "antigravity-cli");
  for (const path of [join(root, "conversations", `${conversationId}.db`), join(root, "conversations", `${conversationId}.db-wal`), join(root, "conversations", `${conversationId}.db-shm`), join(root, "brain", conversationId)]) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function agyChat(model: string, system: string, user: string, timeoutMs: number, binary: string | null = agyBinary()): Promise<AgyTurn> {
  if (!binary) return Promise.reject(new AgyFailure("agy not installed", 0));
  const prompt = `${system}\n\n${user}`;
  if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) return Promise.reject(new AgyFailure("prompt too long for agy", 0));
  if (running >= MAX_PARALLEL) return Promise.reject(new AgyFailure("agy busy", 0));
  running += 1;
  return new Promise<AgyTurn>((resolve, reject) => {
    execFile(binary, ["-p", prompt, "--model", model, "--output-format", "json", "--disable-slash-commands", "--sandbox"],
      { cwd: tmpdir(), timeout: Math.max(1, timeoutMs), maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        running -= 1;
        let body: { conversation_id?: string; status?: string; response?: string; usage?: { input_tokens?: number; output_tokens?: number } } | null = null;
        try { body = JSON.parse(String(stdout).trim().split("\n").filter(Boolean).pop() ?? "null"); } catch { body = null; }
        if (body?.conversation_id) forget(body.conversation_id);
        if (error) {
          const timedOut = (error as { killed?: boolean }).killed === true || /timed? ?out/i.test(String(error.message));
          const text = `${String(stderr)} ${error.message}`;
          return reject(new AgyFailure(text.slice(0, 300), /quota|exhausted|429|rate/i.test(text) ? 429 : 0, timedOut));
        }
        if (!body || body.status !== "SUCCESS" || typeof body.response !== "string") return reject(new AgyFailure(`agy answered ${body?.status ?? "nothing readable"}`, 0));
        resolve({ content: body.response, tokensIn: body.usage?.input_tokens ?? 0, tokensOut: body.usage?.output_tokens ?? 0 });
      });
  });
}
