import type { PhaseApi } from "./driver";

export const PHASE_USAGE = "bb lane-pilot phase list [--project <id>] | show <phase-id> [--book] | drive | return <phase-id> <discussion|planning|design|execution> <note> | pause|resume <phase-id> | close <phase-id> <words>   (phases on rails: stages, gates, the phase book)";
type Result = { exitCode: number; stdout?: string; stderr?: string };

export async function runPhaseCli(api: PhaseApi, argv: readonly string[]): Promise<Result> {
  try {
    const [command, id, ...rest] = argv;
    if (command === "list") {
      const project = argv.indexOf("--project") >= 0 ? argv[argv.indexOf("--project") + 1] : undefined;
      const rows = api.list({ projectId: project, limit: 50 });
      return { exitCode: 0, stdout: rows.map((phase) => `${phase.id}  ${phase.stage.padEnd(12)} ${phase.state.padEnd(15)} ${phase.title}`).join("\n") || "no phases" };
    }
    if (command === "show" && id) {
      const status = api.status(id);
      return { exitCode: 0, stdout: argv.includes("--book") ? status.book : JSON.stringify({ phase: status.phase, next: status.next, gates: status.gates, facts: status.facts }, null, 2) };
    }
    if (command === "drive") return { exitCode: 0, stdout: `moved ${await api.tick()} phase(s)` };
    if (command === "return" && id && rest.length >= 2) return { exitCode: 0, stdout: api.status(api.returnTo({ phaseId: id, to: rest[0] as never, note: rest.slice(1).join(" "), by: "owner" }).id).next.text };
    if ((command === "pause" || command === "resume") && id) return { exitCode: 0, stdout: api.status(api.setState({ phaseId: id, state: command, by: "owner" }).id).next.text };
    if (command === "close" && id && rest.length) return { exitCode: 0, stdout: api.status(api.setState({ phaseId: id, state: "close", words: rest.join(" "), by: "owner" }).id).next.text };
    return { exitCode: 1, stderr: PHASE_USAGE };
  } catch (cause) {
    const why = (cause as { why?: string[] }).why;
    return { exitCode: 1, stderr: `${cause instanceof Error ? cause.message : String(cause)}${why?.length ? `: ${why.join("; ")}` : ""}` };
  }
}
