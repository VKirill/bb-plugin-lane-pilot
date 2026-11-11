import { noteEngineWrite, gateRunVerdict } from "../../verification/server";
import { parseIntegrationGateSettings } from "./workflow-chain-runtime";
import { getRun, getRunSettingsScopes, latestGateRun, listOpenAttempts, listOpenWorktrees, listTaskIdsForRun, listAttemptsForTask, loadProjectSettings, fullGateVerdict, saveProjectSetting } from "../../storage";
import { getPhase, listPhases } from "../../phase";
import { profilePairProblem, unsafeReason } from "../../anamnesis";
import { bestEffort, sha256Hex } from "@lane-pilot/kit";
import { list, rec, str, pmCheckout, quote, needLanePilot } from "./workflow-chain-runtime";
import type { Row } from "./workflow-chain-runtime";
import type { StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { switchWord } from "@lane-pilot/models";
import { runOnHost } from "@lane-pilot/host-calls";
import { instructionForms } from "../../project-life";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";

type Action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;
type PlanHome = (projectId: string, checkout: { hostId: string; path: string }) => Promise<string | null>;
type FlagOf = (rt: ChainRuntime, key: string) => boolean;

/** The actions that read the project's own state (run, gate, phases, requirements) and write its planning bookkeeping
 * (profile, milestone archive, living retro), plus the review pre-pass that scans a diff on the host. */
export function registerProjectActions(engine: WorkflowEngine, ctx: ServerCore, deps: {
  action: Action;
  planHome: PlanHome;
  flagOf: FlagOf;
}): void {
  const { bb, db } = ctx;
  const { action, planHome, flagOf } = deps;

  // The one profile writer (SMA k_pl_infra): the start's preview hands the profile object over and it lands in the project's
  // profile.* settings — the same keys `bb lane-pilot profile` reads and sets. Every key name (password, secret, token, api
  // key, credential, private key), every unknown key and every value goes through the anamnesis unsafeReason first; a refused
  // pair is skipped and reported by key name only, never by content.
  action("lp.profile_write", async (c, rt) => {
    const params = rec(rec(c.node).params);
    let profile: unknown = params.profile === undefined ? undefined : c.template(params.profile);
    if (typeof profile === "string") { try { profile = JSON.parse(profile); } catch { profile = undefined; } }
    const entries = Object.entries(rec(profile)).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value));
    // A refused pair is skipped and named by key with its reason (never the value); the others are written and the start goes on.
    const problems = entries.map(([key, value]) => [key, profilePairProblem(key, String(value))] as const).filter(([, problem]) => problem !== null);
    const refused = problems.map(([key]) => key);
    const set: string[] = [];
    for (const [key, value] of entries.filter(([key]) => !refused.includes(key))) {
      saveProjectSetting(db, rt.projectId, `profile.${key}`, String(value));
      set.push(key);
    }
    for (const [key, problem] of problems) ctx.log(`lp.profile_write: pair «${key.slice(0, 40)}» refused: ${problem}`);
    await writeInstructionForms(rt, profile);
    return { refused, set, reasons: problems.map(([key, problem]) => `${key.slice(0, 40)}: ${problem}`) };
  });

  // The agent-instruction forms go with the start's profile write (SMA k_d_tpl_instructions): CLAUDE.md and the Copilot
  // instructions are pointers to PROJECT.md, and the «Developer preferences» section is appended to it (or a minimal
  // PROJECT.md seeded when it is not there yet). Every write is create-only or hash-checked: BB answers `conflict` to
  // a null-hash write over an existing file, so a person's CLAUDE.md is never replaced. (writePhaseBook cannot do this:
  // it takes phase and planning marks only.)
  async function writeInstructionForms(rt: ChainRuntime, profile: unknown): Promise<void> {
    const checkout = await bestEffort(ctx.log, "instruction forms checkout", pmCheckout(rt), null);
    if (!checkout) return;
    const root = (await planHome(rt.projectId, checkout)) ?? checkout.path;
    const projectPath = ".agents/planning/PROJECT.md";
    const host = ctx.host as never as { call(m: string, i: unknown, o?: unknown): Promise<Record<string, unknown>> };
    const current = await bestEffort(ctx.log, "instruction forms PROJECT.md", host.call("readBoundedFile", { requestedHostId: checkout.hostId, projectCwd: root, relativePath: projectPath, offset: 0, maxLines: 2000 }, { hostId: checkout.hostId, timeoutMs: 20_000 }), null);
    const prof = rec(profile);
    const name = checkout.path.split("/").filter(Boolean).pop() ?? "project";
    const forms = instructionForms({ name, test: str(prof.test_command), language: str(prof.stack), style: str(prof.style) });
    const write = (rootPath: string, path: string, content: string, expectedSha256: string | null) =>
      bestEffort(ctx.log, `instruction forms ${path}`, bb.sdk.files.write({ hostId: checkout.hostId, rootPath, path: `${rootPath}/${path}`, content, contentEncoding: "utf8", createParents: true, expectedSha256 }), null);
    const writePointers = async () => {
      for (const [path, content] of [["CLAUDE.md", forms.claudeMd], [".github/copilot-instructions.md", forms.copilotInstructions]] as const) {
        noteEngineWrite(checkout.path, path);
        await write(checkout.path, path, content, null);
      }
    };
    // A fresh start has no PROJECT.md yet (the recap writes it later); the forms still go in, and the pointers need
    // the canon to resolve, so a minimal PROJECT.md is seeded first — create-only: a file that appeared in between
    // wins and is left for the recap to merge into.
    if (!current || typeof current.content !== "string" || !current.content.trim()) {
      noteEngineWrite(root, projectPath);
      await write(root, projectPath, `# ${name}\n\n${forms.preferences}`, null);
      await writePointers();
      return;
    }
    await writePointers();
    if (current.truncated !== true && typeof current.sha256 === "string" && current.sha256 === sha256Hex(current.content) && !current.content.includes("Developer preferences"))
      await write(root, projectPath, `${current.content.trimEnd()}\n\n${forms.preferences}`, current.sha256);
  }

  // A project's switch for a new behaviour (unset = off, as before the change): read when the node runs, so any graph can use it.
  const switchOf = (rt: ChainRuntime, key: string): string => String(loadProjectSettings(db, rt.projectId, rt.runId ? getRunSettingsScopes(db, rt.runId) : [])[key] ?? "").trim().toLowerCase();

  // Ids of REQUIREMENTS.md that no closed phase of the project covers in its plan items (SMA k_c_auditms). Advisory: it never stops a close.
  const requirementCoverage = async (rt: ChainRuntime) => {
    const checkout = await pmCheckout(rt);
    const text = (await bestEffort(ctx.log, "requirements read", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: (await planHome(rt.projectId, checkout)) ?? checkout.path, command: "cat .agents/planning/REQUIREMENTS.md 2>/dev/null || true", timeoutSec: 15, timeoutMs: 20_000 }), null))?.stdout ?? "";
    const ids = [...new Set([...text.matchAll(/\bREQ-[A-Za-z0-9][\w.-]*/g)].map((hit) => hit[0]))];
    // The coverage matrix (SMA k_c_auditms): every requirement id against the closed phases that cover it.
    const byPhase = listPhases(db, { projectId: rt.projectId }).filter((phase) => phase.stage === "closed" || phase.state === "closed")
      .map((phase) => ({ id: phase.id, covers: (phase.record.plan?.items ?? []).flatMap((item) => item.covers ?? []) }));
    const covered = new Set(byPhase.flatMap((phase) => phase.covers));
    const matrix = ids.map((id) => `${id}: ${byPhase.filter((phase) => phase.covers.includes(id)).map((phase) => phase.id).join(", ") || "—"}`).join("\n");
    return { uncovered: ids.filter((id) => !covered.has(id)), covered: ids.filter((id) => covered.has(id)), total: ids.length, matrix };
  };

  action("lp.run_status", async (c, lane) => {
    const rt = needLanePilot(lane, "lp.run_status");
    const runId = str(c.resolve("$inputs.run_id")) || rt.runId;
    const open = listOpenAttempts(db).filter((row) => row.run_id === runId);
    const tasks = listTaskIdsForRun(db, runId);
    const latest = tasks.map((taskId) => listAttemptsForTask(db, runId, taskId).at(-1)).filter(Boolean) as Array<{ state: string }>;
    const failed = latest.filter((attempt) => ["blocked", "canceled", "validation_failed"].includes(attempt.state)).length;
    // gate_ok and unmerged keep the values the ask_finish condition always had; the real gate state, the work that has not landed
    // (this project's phase candidates and open phase worktrees) and the uncovered requirements are separate readings for the summary text.
    const gate = latestGateRun(db, rt.projectId);
    const gateVerdict = gateRunVerdict(gate);
    const gateState = !gate ? "none" : gateVerdict.pending ? "running" : gateVerdict.failed ? "red" : "green";
    const phases = listPhases(db, { projectId: rt.projectId });
    const unlanded = phases.filter((phase) => !phase.closedAt && phase.record.candidate && !phase.record.candidate.off && Object.keys(phase.record.candidate.trees).length > 0 && !phase.record.candidate.landedAt).length;
    const mine = new Set(phases.map((phase) => phase.id));
    const phaseTrees = listOpenWorktrees(db).filter((tree) => tree.owner_kind === "phase" && !!tree.owner_id && mine.has(tree.owner_id)).length;
    const coverage = await bestEffort(ctx.log, "requirement coverage", requirementCoverage(rt), { uncovered: [] as string[], covered: [] as string[], total: 0, matrix: "" });
    return { open_tasks: tasks.length - latest.filter((attempt) => attempt.state === "accepted").length - failed, failed_tasks: failed, unmerged: 0, gate_ok: failed === 0, running_attempts: open.length, merged_commits: list(c.resolve("ctx.merged_commits")).map(String),
      gate_state: gateState, unmerged_seen: Math.max(unlanded, phaseTrees), uncovered_reqs: coverage.uncovered, coverage_matrix: coverage.matrix,
      retro_living: flagOf(rt, "retro.living") ? "on" : "off", milestone_archive: flagOf(rt, "milestone.archive") ? "on" : "off", milestone_summary: flagOf(rt, "milestone.summary") ? "on" : "off" };
  });

  // The full-gate mark (SMA k_ws_fullgate), only where the project set ship.full_gate to on; unset the node answers ok as it always did.
  // On: the ship needs proof the integration gate ran green no more than six hours ago, and on the head being shipped when the run
  // knows it (input head, else the phase candidate's one verified head). A project without a gate passes as before; a configured gate never run does not.
  action("lp.integration_gate_status", async (c, rt) => {
    if (!flagOf(rt, "ship.full_gate")) return { ok: true, failing: [], skipped: true };
    const gate = latestGateRun(db, rt.projectId);
    const phaseId = str(c.resolve("$inputs.phase_id"));
    const verified = Object.values((phaseId ? getPhase(db, phaseId) : undefined)?.record.candidate?.verified ?? {});
    const head = str(c.resolve("$inputs.head")) || (verified.length === 1 ? verified[0]! : "") || null;
    if (!gate) {
      const settings = parseIntegrationGateSettings(loadProjectSettings(db, rt.projectId, rt.runId ? getRunSettingsScopes(db, rt.runId) : []));
      return settings.gateOff || !settings.gateCommand
        ? { ok: true, failing: [], reason: "", skipped: true }
        : { ok: false, failing: [`integration gate not run: no run of \`${settings.gateCommand}\` is recorded for this project`], reason: "the integration gate never ran" };
    }
    const verdict = fullGateVerdict(gate, head);
    return { ok: verdict.ok, failing: verdict.ok ? [] : [verdict.reason], reason: verdict.reason };
  });

  action("lp.run_close", async (c, lane) => {
    const rt = needLanePilot(lane, "lp.run_close");
    const runId = str(c.resolve("$inputs.run_id")) || rt.runId;
    // The PM's run is closed by the PM chat's own lifecycle (closeAbandonedRuns); this marks the workflow's end and leaves the run to it.
    return { archived: Boolean(getRun(db, runId)) };
  });

  // Coverage as a node of its own (advisory): a graph that wants the list without lp.run_status can still call it.
  action("lp.requirement_coverage", async (_c, rt) => requirementCoverage(rt));

  // The milestone archive (SMA k_pl_milestones), only where the project set milestone.archive to on: a snapshot of the roadmap and
  // requirements under .agents/planning/milestones/<slug>-<sha8>/, indexed in INDEX.md. The folder name is a slug that cannot start
  // with a dot plus the first 8 hex of the sha of the full name, so two long goals with one beginning do not collide. A second archive
  // of the same name keeps the first snapshot. Every write is best effort: a failure is logged and returned, never thrown, so a close goes on.
  action("lp.milestone_archive", async (c, rt) => {
    if (!flagOf(rt, "milestone.archive")) return { folder: "", files: [] as string[], kept: false, skipped: true };
    let dir = "";
    try {
      const checkout = await pmCheckout(rt);
      const root = (await planHome(rt.projectId, checkout)) ?? checkout.path;
      const read = async (rel: string) => (await bestEffort(ctx.log, "milestone archive read", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: root, command: `cat ${quote(rel)} 2>/dev/null || true`, timeoutSec: 15, timeoutMs: 20_000 }), null))?.stdout ?? "";
      const write = async (rel: string, content: string) => {
        if (root === checkout.path) noteEngineWrite(checkout.path, rel);
        await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: root, path: `${root}/${rel}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
      };
      // The closing milestone is named by its goal. new-milestone names none: the previous milestone is the roadmap's own heading when it has one, else the date.
      const params = rec(rec(c.node).params);
      const closing = "name" in params;
      const heading = closing ? "" : /^#\s+(.+)$/m.exec(await read(".agents/planning/ROADMAP.md"))?.[1]?.replace(/^\s*(roadmap|дорожная карта)\s*[:—–-]*\s*/i, "").trim() ?? "";
      const name = (closing ? str(c.render(str(params.name))).trim() || str(c.resolve("$inputs.run_id")) : heading) || new Date().toISOString().slice(0, 10);
      const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 40).replace(/-+$/, "") || "milestone";
      dir = `.agents/planning/milestones/${slug}-${sha256Hex(name).slice(0, 8)}`;
      const kept = await runOnHost(ctx.host, { hostId: checkout.hostId, cwd: root, command: `test -f ${quote(`${dir}/ROADMAP.md`)} && echo yes`, timeoutSec: 15, timeoutMs: 20_000 }).then((ran) => ran.stdout.trim() === "yes", () => false);
      const files: string[] = [];
      if (!kept) {
        for (const file of ["ROADMAP.md", "REQUIREMENTS.md"]) {
          const body = await read(`.agents/planning/${file}`);
          if (body.trim()) { await write(`${dir}/${file}`, body); files.push(file); }
        }
        const index = await read(".agents/planning/milestones/INDEX.md");
        await write(".agents/planning/milestones/INDEX.md", `${index}${index && !index.endsWith("\n") ? "\n" : ""}- ${slug}-${sha256Hex(name).slice(0, 8)}: ${name.replace(/\s+/g, " ").slice(0, 120)} (archived ${new Date().toISOString().slice(0, 10)}: ${files.join(" + ") || "nothing to copy"})\n`);
      }
      return { folder: dir, files, kept };
    } catch (cause) {
      const failed = cause instanceof Error ? cause.message : String(cause);
      ctx.log(`milestone archive failed, the close goes on: ${failed}`);
      return { folder: dir, files: [] as string[], kept: false, failed };
    }
  });

  // The living retrospective (SMA k_d_tpl_milestone), only where the project set retro.living to on: insights upserted by their INS id into
  // .agents/retro/LIVING.md — a repeated id only moves its last-seen milestone, nothing is ever deleted. The model's text is cut to one
  // plain line, an id that is not INS-<8 hex> is dropped, and a failed write is logged, not thrown.
  action("lp.retro_living", async (c, rt) => {
    const path = ".agents/retro/LIVING.md";
    if (!flagOf(rt, "retro.living")) return { updated: 0, total: 0, path: "", skipped: true };
    try {
      const checkout = await pmCheckout(rt);
      const line = (value: unknown, max: number) => str(value).replace(/[<>`\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
      const insights = list(c.resolve("retro.insights") ?? c.resolve("$inputs.insights")).map(rec);
      const milestone = line(c.resolve("$inputs.goal"), 80) || line(c.resolve("$inputs.run_id"), 80) || line(c.runId, 80) || "milestone";
      const byId = new Map(insights.filter((ins) => /^INS-[0-9a-f]{8}$/.test(str(ins.id))).map((ins) => [str(ins.id), { id: str(ins.id), title: line(ins.title ?? ins.text, 200), lens: /^(technical|process|quality|decision)$/.test(str(ins.lens)) ? str(ins.lens) : "" }]));
      if (!byId.size) return { updated: 0, total: 0, path };
      const prev = (await bestEffort(ctx.log, "living retro read", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command: `cat ${quote(path)} 2>/dev/null || true`, timeoutSec: 15, timeoutMs: 20_000 }), null))?.stdout ?? "";
      const seen = new Set<string>();
      const lines = (prev.trim() ? prev.split("\n") : ["# Living retrospective", ""]).map((row) => {
        const id = /INS-[A-Za-z0-9]{6,}/.exec(row)?.[0];
        if (id && byId.has(id)) { seen.add(id); return `${row.replace(/\s*\(last seen [^)]*\)\s*$/, "")} (last seen ${milestone})`; }
        return row;
      });
      for (const { id, title, lens } of byId.values()) if (!seen.has(id)) lines.push(`- ${id}${lens ? ` [${lens}]` : ""}${title ? ` ${title}` : ""} (last seen ${milestone})`);
      noteEngineWrite(checkout.path, path);
      await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${path}`, content: `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`, contentEncoding: "utf8", createParents: true, expectedSha256: null });
      return { updated: byId.size, total: lines.filter((row) => /- INS-[A-Za-z0-9]{6,}/.test(row)).length, path };
    } catch (cause) {
      ctx.log(`living retro not written, the close goes on: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { updated: 0, total: 0, path };
    }
  });

  // The structural pre-pass of a review (SMA k_wr_prepass): cheap checks on the host before any model reads the code. It reads what the
  // review's range ADDED (git diff -U0), never whole files, so a line that was already there is not the task's fault: conflict markers,
  // leftover debugger/.only( in code files, secret-like lines (reported by location and kind, never the value), and git diff --check
  // limited to the same range. A checkout that is not git, or an empty diff, gives no finding. By default the findings are only notes
  // handed to the reviewers; with review.prepass = strict they join the verdict and a quick review with a critical one is rework without a model.
  action("lp.review_prepass", async (c, rt) => {
    const strict = switchWord(loadProjectSettings(db, rt.projectId, rt.runId ? getRunSettingsScopes(db, rt.runId) : []), "review.prepass") === "strict";
    const none = { findings: [] as Row[], notes: "", critical_count: 0, rework: false };
    const checkout = await bestEffort(ctx.log, "review prepass checkout", pmCheckout(rt), null);
    const files = list(c.resolve("scope.files") ?? c.resolve("$inputs.files")).map(String).slice(0, 100);
    if (!checkout || !files.length) return none;
    const range = c.resolve("$inputs.range"), pr = str(c.resolve("$inputs.pr"));
    const only = `-- ${files.map(quote).join(" ")}`;
    const [diffCmd, checkCmd] = Array.isArray(range) && range.length
      ? [`git show -U0 --format= ${range.map((commit) => quote(String(commit))).join(" ")} ${only}`, `git show --check --format= ${range.map((commit) => quote(String(commit))).join(" ")} ${only}`]
      : typeof range === "string" && range ? [`git diff -U0 ${quote(range)} ${only}`, `git diff --check ${quote(range)} ${only}`]
      : pr ? [`gh pr diff ${quote(pr)}`, ""]
      : [`git diff -U0 HEAD ${only}`, `git diff --check HEAD ${only}`];
    const scan = async (command: string) => command ? (await bestEffort(ctx.log, "review prepass", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command: `${command} 2>/dev/null; true`, timeoutSec: 60, timeoutMs: 75_000 }), null))?.stdout ?? "" : "";
    const found: Row[] = [];
    const add = (file: string, line: number, severity: string, evidence: string) => found.push({ id: `pp-${found.length + 1}`, file: `${file}:${line}`, line, severity, evidence });
    let file = "", at = 0;
    for (const row of (await scan(diffCmd)).split("\n")) {
      const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(row), hunk = /^@@ -\S+ \+(\d+)/.exec(row);
      if (header) { file = header[1]!.trim(); continue; }
      if (hunk) { at = Number(hunk[1]); continue; }
      if (!row.startsWith("+") || !file || file === "/dev/null" || found.length >= 60) continue;
      const added = row.slice(1);
      if (/^(<{7}|>{7})(\s|$)/.test(added)) add(file, at, "critical", "merge conflict marker left in the file");
      else if (/\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/.test(file) && /\bdebugger\b|\.only\(/.test(added)) add(file, at, "high", "leftover debugger or focused test");
      else { const reason = unsafeReason(added); if (reason) add(file, at, "critical", `possible ${reason} (location only, the value is withheld)`); }
      at += 1;
    }
    for (const row of (await scan(checkCmd)).split("\n")) {
      const hit = /^(.+?):(\d+): (.+)$/.exec(row);
      if (hit && !row.startsWith("+") && found.length < 80) add(hit[1]!, Number(hit[2]), "medium", `git diff --check: ${hit[3]!.slice(0, 120)}`);
    }
    const critical = found.filter((finding) => finding.severity === "critical").length;
    if (strict) return { findings: found, notes: "", critical_count: critical, rework: critical > 0 && c.resolve("scope.level") === "quick" };
    return { findings: [] as Row[], notes: found.slice(0, 20).map((finding) => `${finding.file} ${finding.severity}: ${finding.evidence}`).join("\n"), critical_count: critical, rework: false };
  });
}
