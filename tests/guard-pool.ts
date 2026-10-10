import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
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

export type GuardRun = { status: number | null; stdout: string; stderr: string };

/**
 * The same warm Python for tests that call the guard one case at a time and wait for the answer (a spawnSync before): requests and
 * replies go through two FIFOs read and written with blocking file calls, so the test body stays synchronous. The options are the
 * ones of the spawnSync it replaces: the payload in `input`, a complete environment in `env`, the working directory in `cwd`.
 */
export function useGuardSync(guard: string) {
  let proc: ReturnType<typeof spawn> | null = null;
  let requestFd = -1;
  let replyFd = -1;
  let dir = "";
  let nextId = 1;
  const start = () => {
    dir = mkdtempSync(join(tmpdir(), "guard-sync-"));
    const request = join(dir, "request");
    const reply = join(dir, "reply");
    execFileSync("mkfifo", [request, reply]);
    proc = spawn("python3", [server, guard, request, reply], { stdio: "ignore" });
    proc.unref();
    // Neither open may wait for the other side: a server that failed to start would then hang the worker for good.
    requestFd = openSync(request, constants.O_RDWR);
    replyFd = openSync(reply, constants.O_RDONLY | constants.O_NONBLOCK);
  };
  const stop = () => {
    for (const fd of [requestFd, replyFd]) if (fd >= 0) try { closeSync(fd); } catch { /* already closed */ }
    requestFd = replyFd = -1;
    proc?.kill();
    proc = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  };
  afterAll(stop);
  return function run(options: { input: string; env?: NodeJS.ProcessEnv; cwd?: string }): GuardRun {
    if (!proc) start();
    const id = nextId++;
    writeSync(requestFd, `${JSON.stringify({ id, input: options.input, env: options.env ?? hookEnv({}), ...(options.cwd ? { cwd: options.cwd } : {}) })}\n`);
    let text = Buffer.alloc(0);
    const chunk = Buffer.alloc(65536);
    const deadline = Date.now() + 30_000;
    while (!text.includes(10)) {
      let read = 0;
      try { read = readSync(replyFd, chunk, 0, chunk.length, null); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      }
      if (read > 0) { text = Buffer.concat([text, chunk.subarray(0, read)]); continue; }
      // Nothing yet (or the server has not opened its end yet): wait a moment, without the event loop.
      if (Date.now() > deadline) throw new Error("the guard server did not answer within 30 s");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    const answer = JSON.parse(text.toString("utf8")) as { id: number; status: number | null; stdout: string; stderr: string };
    return { status: answer.status, stdout: answer.stdout, stderr: answer.stderr };
  };
}
