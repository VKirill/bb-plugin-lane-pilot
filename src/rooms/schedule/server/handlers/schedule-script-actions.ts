import { pollPause, redactKnown } from "@lane-pilot/kit";
import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../../contracts/server";
import { allowedSecretNames, secretFixLines, secretProblem } from "../../../secrets/server";
import { loadProjectSettings, recordSecretIssuance } from "../../../storage";

const textVal = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Registers the `lp.schedule_script` step executor for `workflows/lp.schedule-script.json`: resolves allowed Env Catalog
 * secrets, starts the host `runScript` job through a durable effect (idempotent on `runKey`), and waits for completion.
 */
export function registerScheduleScriptActions(engine: WorkflowEngine, ctx: ServerCore): void {
  const { bb, db } = ctx;
  engine.register<ChainRuntime>("lp.schedule_script", {
    reentrant: true,
    run: async (c: StepContext<ChainRuntime>) => {
      const projectId = c.runtime?.projectId ?? "";
      const scheduleId = textVal(c.resolve("$inputs.scheduleId"));
      const hostId = textVal(c.resolve("$inputs.hostId"));
      const command = textVal(c.resolve("$inputs.command"));
      const cwd = textVal(c.resolve("$inputs.cwd"));
      const rawEnv = c.resolve("$inputs.env");
      const envNames = Array.isArray(rawEnv) ? rawEnv.map(String) : [];
      const timeoutSec = Number(c.resolve("$inputs.timeoutSec")) || 600;
      const maxOutputBytes = Number(c.resolve("$inputs.maxOutputBytes")) || 0;
      const runKey = textVal(c.resolve("$inputs.runKey")) || c.runId;

      let env: Record<string, string> = {};
      if (envNames.length) {
        const resolved = await ctx.secrets.resolve({ declared: envNames, allowed: allowedSecretNames(loadProjectSettings(db, projectId)) });
        const problem = secretProblem(resolved);
        if (problem.length || resolved.unavailable) throw new Error(`secrets_not_ready: ${secretFixLines(resolved).join(" ")}`);
        env = Object.assign({}, ...envNames.map((name) => resolved.byName[name] ?? {})) as Record<string, string>;
        for (const name of envNames) {
          try { recordSecretIssuance(db, { projectId, consumer: "schedule", secretName: name, hostId, checkCommand: `schedule ${scheduleId}` }); } catch (cause) { bb.log.warn(`secret issuance journal: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
      }

      const { jobId } = await c.effect<{ jobId: string }>("job", "host_job", async () => {
        const reply = await ctx.host.call("jobStart", {
          requestedHostId: hostId, kind: "runScript",
          input: { requestedHostId: hostId, command, cwd, timeoutSec, ...(Object.keys(env).length ? { env } : {}), ...(maxOutputBytes > 0 ? { maxOutputBytes } : {}) },
          timeoutSec: Math.min(10_800, timeoutSec + 30), key: runKey,
        }, { hostId, timeoutMs: 30_000 });
        return { jobId: reply.jobId };
      }, { reconcile: async () => ({ happened: false }) });

      const interrupted = (): Promise<never> => new Promise<never>(() => undefined);
      for (;;) {
        if (c.signal.aborted) {
          await ctx.host.call("jobCancel", { requestedHostId: hostId, jobId }, { hostId, timeoutMs: 20_000 }).catch((cause: unknown) => ctx.log(`schedule job cancel of ${jobId} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
          throw new Error("schedule script run canceled");
        }
        if (ctx.isDisposed()) return await interrupted();
        const status = await ctx.host.call("jobStatus", { requestedHostId: hostId, jobId }, { hostId, timeoutMs: 20_000 });
        if (status.state !== "running") {
          if (status.state !== "succeeded") {
            return { output: { status: "failed", output: "", error: redactKnown(status.error ?? `the host job is ${status.state}`), reason: `job_${status.state}`, truncated: false, jobId, hostId } };
          }
          const result = status.result as { exitCode: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean };
          const output = redactKnown([result.stdout, result.stderr ? `--- stderr ---\n${result.stderr}` : ""].filter(Boolean).join("\n"));
          return result.exitCode === 0
            ? { output: { status: "succeeded", exitCode: 0, output, error: "", reason: "", truncated: result.truncated, jobId, hostId } }
            : { output: { status: "failed", exitCode: result.exitCode, output, error: result.timedOut ? "the script's own time limit" : `exit code ${result.exitCode}`, reason: result.timedOut ? "timeout" : "exit_code", truncated: result.truncated, jobId, hostId } };
        }
        await new Promise<void>((wake) => setTimeout(wake, pollPause(1_000)));
      }
    },
  });
}
