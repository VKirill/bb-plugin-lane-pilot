import type { PhaseApi } from "./driver";

export const PHASE_USAGE = "bb lane-pilot phase list [--project <id>] | show <phase-id> [--book] | drive | return <phase-id> <discussion|planning|design|execution> <note> | pause|resume <phase-id> | close <phase-id> <words> | uat [--project <id>] | state <phase-id|--project id> [--set k=v] [--decision text] [--blocker text] | roadmap <phase-id|--project id> [row]   (phases on rails: stages, gates, the phase book)";
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
    if (command === "drive") { const pass = await api.tick(); return { exitCode: 0, stdout: `moved ${pass.moved} phase(s)${pass.idle ? `; idle: ${pass.idle}` : ""}` }; }
    // Open acceptance items across all phases (SMA k_t_audit_uat): exit 1 while any remain.
    if (command === "uat") {
      const project = argv.indexOf("--project") >= 0 ? argv[argv.indexOf("--project") + 1] : undefined;
      const rows = await api.uatOpen({ projectId: project });
      return { exitCode: rows.length ? 1 : 0, stdout: rows.map((row) => `${row.phaseId}  ${row.state.padEnd(6)} ${row.line}`).join("\n") || "no open acceptance lines" };
    }
    // STATE.md read and edited (SMA k_t_state): no flag prints it parsed; the flags edit command-owned parts only.
    if (command === "state") {
      const flag = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
      const out = await api.state({ phaseId: id && !id.startsWith("--") ? id : undefined, projectId: flag("--project"), set: flag("--set"), decision: flag("--decision"), blocker: flag("--blocker") });
      if (!rest.length && !(id?.startsWith("--"))) return { exitCode: 0, stdout: out.text || "no STATE.md" };
      return { exitCode: 0, stdout: out.text || `position: ${out.marks.stage ?? "—"}; decisions: ${(out.sections.Decisions ?? []).length}; blockers: ${(out.sections.Blockers ?? []).length}` };
    }
    // The roadmap read with the disk (SMA k_t_roadmap): a row's section, or the analysis and the next open row.
    if (command === "roadmap") {
      const project = argv.indexOf("--project") >= 0 ? argv[argv.indexOf("--project") + 1] : undefined;
      const row = id && !id.startsWith("--") && !id.startsWith("ph_") ? id : rest.find((arg) => !arg.startsWith("--"));
      const out = await api.roadmap({ phaseId: id?.startsWith("ph_") ? id : undefined, projectId: project, row });
      if (out.section !== undefined) return { exitCode: out.section === null ? 1 : 0, stdout: out.section ?? `no row ${row}` };
      const a = out.analysis!;
      return { exitCode: 0, stdout: [`ticked without SUMMARY.md: ${a.tickedWithoutSummary.join("; ") || "none"}`, `phase folders with no row: ${a.foldersWithoutRow.join(", ") || "none"}`, `next open row: ${a.next ? `${a.next.n} ${a.next.name}` : "none"}`].join("\n") };
    }
    if (command === "return" && id && rest.length >= 2) return { exitCode: 0, stdout: api.status(api.returnTo({ phaseId: id, to: rest[0] as never, note: rest.slice(1).join(" "), by: "owner" }).id).next.text };
    if ((command === "pause" || command === "resume") && id) return { exitCode: 0, stdout: api.status(api.setState({ phaseId: id, state: command, by: "owner" }).id).next.text };
    if (command === "close" && id && rest.length) return { exitCode: 0, stdout: api.status(api.setState({ phaseId: id, state: "close", words: rest.join(" "), by: "owner" }).id).next.text };
    return { exitCode: 1, stderr: PHASE_USAGE };
  } catch (cause) {
    const why = (cause as { why?: string[] }).why;
    return { exitCode: 1, stderr: `${cause instanceof Error ? cause.message : String(cause)}${why?.length ? `: ${why.join("; ")}` : ""}` };
  }
}
