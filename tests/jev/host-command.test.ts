import { describe, expect, it } from "vitest";
import { createJev, setJevForTests, type JevAnswer, type JevClient, type JevRequest } from "@lane-pilot/jev";
import { hostCommandJudgment } from "@lane-pilot/jev/judgments/host-command";
import { guardShellPort, type ShellPort } from "../../src/rooms/checkers/workspace";

function clientReturning(destructiveP: number, harmP: number): { client: JevClient; last: () => JevRequest | null } {
  let last: JevRequest | null = null;
  return {
    last: () => last,
    client: {
      breaker: () => ({ open: false, failures: 0 }),
      async call(request: JevRequest) {
        last = request;
        const answers: Record<string, JevAnswer> = {};
        for (const [id, q] of Object.entries(request.questions)) {
          if (q.type === "noul") answers[id] = { type: "noul", noul: harmP };
          else answers[id] = { type: "choice", choice: "routine", probabilities: { routine: 1 - destructiveP, review: 0, destructive: destructiveP }, confidence: 0.9 };
        }
        return { ok: true, answers, model: "jev-test", usage: { input_tokens: 10, output_tokens: 2 }, latencyMs: 5, attempts: 1 };
      },
    },
  };
}

const echo: ShellPort = { run: async (_d, cmd) => ({ exitCode: 0, stdout: `ran ${cmd}`, stderr: "" }) };

describe("guard.host_command", () => {
  it("decision: routine allows, destructive stops, mid-band reviews", () => {
    const input = { command: "rm -rf /", cwd: "/work", workspaceRoots: ["/work"] };
    const stop = hostCommandJudgment.decide(
      { kind: { type: "choice", choice: "destructive", probabilities: { routine: 0.05, review: 0.05, destructive: 0.9 }, confidence: 0.9 }, harm: { type: "noul", noul: 0.95 } },
      { stop_p: 0.7, review_p: 0.3 }, input);
    expect(stop.decision?.action).toBe("stop");
    expect(stop.decision?.reason).toMatch(/workspace/);
    const review = hostCommandJudgment.decide(
      { kind: { type: "choice", choice: "review", probabilities: { routine: 0.2, review: 0.6, destructive: 0.2 }, confidence: 0.6 }, harm: { type: "noul", noul: 0.4 } },
      { stop_p: 0.7, review_p: 0.3 }, input);
    expect(review.decision?.action).toBe("review");
  });

  it("stateBuilder whitelists fields and clips the command", () => {
    const state = hostCommandJudgment.stateBuilder({ command: "x".repeat(5000), cwd: "/w", workspaceRoots: ["/w"], task: "t", extra: "drop" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["command", "cwd", "task", "workspace"]);
    expect((state.command as string).length).toBeLessThanOrEqual(4000);
  });

  it("shadow records but runs the command; active stops a destructive one", async () => {
    const shell = guardShellPort(echo, () => ({}));
    setJevForTests(createJev({ client: clientReturning(0.95, 0.9).client, db: null }));
    const ran = await shell.run("/work", "rm -rf /", 10);
    expect(ran.exitCode).toBe(0); // shadow: warned on the receipt, work continues
    setJevForTests(createJev({ client: clientReturning(0.95, 0.9).client, db: null }));
    const active = guardShellPort(echo, () => ({ settings: { "jev.modes": "guard.host_command=active" } }));
    const stopped = await active.run("/work", "rm -rf /", 10);
    expect(stopped.exitCode).toBe(78);
    expect(stopped.stderr).toMatch(/guard.host_command/);
    setJevForTests(null);
  });

  it("active mode lets ordinary work through", async () => {
    setJevForTests(createJev({ client: clientReturning(0.02, 0.05).client, db: null }));
    const active = guardShellPort(echo, () => ({ settings: { "jev.modes": "guard.host_command=active" } }));
    const ok = await active.run("/work", "npm test", 10);
    expect(ok.exitCode).toBe(0);
    setJevForTests(null);
  });
});
