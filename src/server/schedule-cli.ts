import type { Services } from "./services";

/**
 * `bb lane-pilot schedule <list|show|create|update|pause|resume|run-now|delete|history|preview>`: the schedule board from a terminal.
 */
export const SCHEDULE_USAGE = [
  "bb lane-pilot schedule list [--project <id>] [--json]",
  "bb lane-pilot schedule show <id> [--runs N] [--json]",
  "bb lane-pilot schedule history <id> [--limit N] [--json]",
  "bb lane-pilot schedule preview '<definition-json>'",
  "bb lane-pilot schedule create '<definition-json>' [--project <id>]",
  "bb lane-pilot schedule update <id> '<changes-json>'",
  "bb lane-pilot schedule pause <id> [reason]",
  "bb lane-pilot schedule resume <id>",
  "bb lane-pilot schedule run-now <id>",
  "bb lane-pilot schedule delete <id>",
].join("\n");

type Result = { exitCode: number; stdout: string };

const FLAGS_WITH_VALUE = new Set(["--project", "--runs", "--limit", "--file"]);

function parse(args: string[]): { positional: string[]; flags: Map<string, string>; json: boolean } {
  const positional: string[] = [], flags = new Map<string, string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (FLAGS_WITH_VALUE.has(arg)) flags.set(arg, args[++index] ?? "");
    else positional.push(arg);
  }
  return { positional, flags, json };
}

const when = (view: { when: { type: string; cron?: string; timezone?: string; runAt?: number } }) =>
  view.when.type === "cron" ? `${view.when.cron} (${view.when.timezone})` : `once ${new Date(view.when.runAt!).toISOString()}`;
const time = (at: number | null | undefined) => (at ? new Date(at).toISOString().replace(".000Z", "Z") : "-");

export async function runScheduleCli(services: Services, args: string[]): Promise<Result> {
  const board = services.schedules;
  const { positional, flags, json } = parse(args.slice(1));
  const sub = args[0] ?? "";
  const out = (value: unknown): Result => ({ exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
  const fail = (message: string): Result => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, error: message }) });
  const jsonArg = async (index: number): Promise<unknown> => {
    // The CLI runs on the hub, so a path would name a file there, not on the caller's machine: the JSON comes inline ("$(cat file.json)").
    if (flags.get("--file")) throw new Error("--file is not supported: pass the JSON inline, e.g. \"$(cat schedule.json)\"");
    const text = positional[index];
    if (!text) throw new Error("give the JSON as an argument");
    return JSON.parse(text) as unknown;
  };

  if (sub === "list") {
    const views = board.list({ ...(flags.get("--project") ? { projectId: flags.get("--project")! } : {}), next: 3 });
    if (json) return out({ schedules: views });
    return out(views.length ? views.map((view) => `${view.id}  ${view.state.padEnd(6)} ${view.column.padEnd(9)} ${view.task.kind.padEnd(8)} ${view.name}  ${when(view)}  next ${time(view.nextFires[0])}`).join("\n") : "no schedules");
  }
  if (sub === "show" && positional[0]) {
    const row = board.store.get(positional[0]);
    if (!row) return fail(`there is no schedule ${positional[0]}`);
    return out({ schedule: board.viewOf(row, 5), total: board.runCount(row.id), runs: board.runs(row.id, Number(flags.get("--runs") ?? 5)) });
  }
  if (sub === "history" && positional[0]) {
    const row = board.store.get(positional[0]);
    if (!row) return fail(`there is no schedule ${positional[0]}`);
    const runs = board.runs(row.id, Number(flags.get("--limit") ?? 20));
    if (json) return out({ total: board.runCount(row.id), runs });
    return out(runs.length ? runs.map((run) => `${time(run.scheduledAt)}  ${run.status.padEnd(9)} ${run.trigger.padEnd(7)} ${run.durationMs === null ? "-" : `${Math.round(run.durationMs / 1000)}s`}  ${run.reason ?? run.error?.slice(0, 80) ?? ""}`).join("\n") : "no runs yet");
  }
  if (sub === "preview") {
    const definition = await jsonArg(0) as Record<string, unknown>;
    const project = flags.get("--project");
    return out(await board.preview(project && !definition.projectId ? { ...definition, projectId: project } : definition));
  }
  if (sub === "create" || sub === "update") {
    const given = await jsonArg(sub === "create" ? 0 : 1) as Record<string, unknown>;
    let definition = given;
    if (sub === "update") {
      const row = board.store.get(positional[0] ?? "");
      if (!row) return fail(`there is no schedule ${positional[0] ?? ""}`);
      definition = { ...board.definitionOf(row), ...given, id: row.id, projectId: row.project_id };
    } else if (flags.get("--project") && !given.projectId) definition = { ...given, projectId: flags.get("--project") };
    const saved = await board.save(definition, "cli");
    return saved.ok ? out({ ok: true, schedule: saved.schedule, warnings: saved.warnings, conflicts: saved.conflicts }) : { exitCode: 1, stdout: JSON.stringify({ ok: false, problems: saved.problems }, null, 2) };
  }
  if ((sub === "pause" || sub === "resume") && positional[0]) {
    const view = board.setPaused(positional[0], sub === "pause", sub === "pause" ? positional.slice(1).join(" ") || undefined : undefined);
    return view ? out({ ok: true, schedule: view }) : fail(`there is no schedule ${positional[0]}`);
  }
  if (sub === "run-now" && positional[0]) {
    const added = board.runNow(positional[0]);
    return added ? out({ ok: true, runId: added.run.id, status: added.run.status, created: added.created }) : fail(`there is no schedule ${positional[0]}`);
  }
  if (sub === "delete" && positional[0]) return board.remove(positional[0]) ? out({ ok: true }) : fail(`there is no schedule ${positional[0]}`);
  return { exitCode: 2, stdout: `usage:\n${SCHEDULE_USAGE}` };
}
