import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { afterAll } from "vitest";
import { hookEnv } from "./hook-env";

export type Verdict = { status: number | null; stdout: string };
export type GuardCase = { command: string; agentType: string | null; env?: Record<string, string> };

const server = join(process.cwd(), "tests/guard-fork-server.py");

/**
 * Runs the shell guard for many cases through one warm Python (tests/guard-fork-server.py): each case is still a fresh forked run of
 * guard_shell.py with its own environment and payload, but the interpreter start and the compile are paid once per file instead of
 * once per case (about 50 ms of CPU each; the two big role tables took 520 + 290 starts). Call it at the top of a test file: the
 * server is stopped after the file's last test.
 */
export function useGuardPool(guard: string, payloadOf: (command: string, agentType: string | null) => string) {
  let child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  let nextId = 1;
  const waiting = new Map<number, (reply: { status: number | null; stdout: string }) => void>();
  let buffered = "";
  const start = () => {
    const proc = spawn("python3", [server, guard], { stdio: ["pipe", "pipe", "inherit"] });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const reply = JSON.parse(buffered.slice(0, end)) as { id: number; status: number | null; stdout: string };
        buffered = buffered.slice(end + 1);
        waiting.get(reply.id)?.(reply);
        waiting.delete(reply.id);
      }
    });
    proc.on("close", () => { for (const [, done] of waiting) done({ status: null, stdout: "" }); waiting.clear(); child = null; });
    return proc;
  };
  const one = ({ command, agentType, env = {} }: GuardCase) => new Promise<Verdict>((done) => {
    const proc = (child ??= start());
    const id = nextId++;
    waiting.set(id, ({ status, stdout }) => done({ status, stdout }));
    proc.stdin.write(`${JSON.stringify({ id, input: payloadOf(command, agentType), env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }) })}\n`);
  });
  afterAll(() => { child?.kill(); child = null; });
  return async function runMany(cases: GuardCase[]): Promise<Verdict[]> {
    return Promise.all(cases.map(one));
  };
}
