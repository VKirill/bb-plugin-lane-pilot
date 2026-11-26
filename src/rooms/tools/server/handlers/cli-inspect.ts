import type { PluginCliResult } from "@get-bb/plugin-sdk";
import { type CliRunDeps } from "./cli-deps";
import { projectStats } from "../services/project-stats";
import { explainCatalog, explainWord } from "../../models/explain";
import { guideDocs } from "../../guide-docs";
import { VERDICT_LIST_COMMAND, renderVerdicts, verdictFiles, verdictInventory } from "../../models/verdicts";
import { attemptRecord, manifest, passport, preship } from "../services/receipts";
import { PROTECTIONS, attemptSessionLayers, calibrationPassport, createHash, getAttempt, getRun, integrityReport, listAttemptReasonsSince, listEvidence, listQaHosts, loadProjectSettings, loadPrototypeConfig, mergeFrontmatter, parseFrontmatter, parseSkillHub, pauseRun, planningHomeInputs, pluginRootFromModule, renewDisarm, resolvePlanningHome, runPmSkillUseCli, runPmSkillsCli, runRollbackCli, runSkillsCli, saveProjectSetting, setFrontmatter, spawnAsync, terminalParity, terminalSessionLayers, unknownReasons, usageSegment } from "./cli-imports";
/** Inspection, protection and report commands of `bb lane-pilot`. Returns undefined when `command` is not one of theirs. */
export async function cliInspect(d: CliRunDeps): Promise<PluginCliResult | undefined> {
  const { bb, db, host } = d.ctx;
  const { ctx, services, command, args, invocation, commands } = d;

  if (command === "reverify" || command === "revert" || command === "changes") {
    return await runRollbackCli(services.rollback, command, args);
  }
  if (command === "evidence") {
    const [projectId] = args.filter((a) => !a.startsWith("--"));
    if (!projectId) return { exitCode:1, stderr:"usage: bb lane-pilot evidence <project-id> [--op permit|revert|janitor] [--days N]" };
    const op = args.includes("--op") ? args[args.indexOf("--op") + 1] : undefined, days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : undefined;
    const rows = await listEvidence(bb.storage.kv as never, projectId, { op, days });
    return { exitCode:0, stdout:rows.map((row) => `${new Date(row.at).toISOString()} ${row.op} ${row.target}\n  why: ${row.why}\n  checks: ${row.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("; ")}\n  by: ${row.by}`).join("\n") || "no evidence records" };
  }
  if (command === "integrity") {
    const [projectId] = args.filter((a) => !a.startsWith("--"));
    const pid = projectId ?? args[0] ?? "";
    if (args.includes("--rearm")) {
      // Switching a protection back on is the owner's word, not an agent's.
      if (invocation?.threadId) return { exitCode:1, stderr:"a protection is re-armed by the owner at a terminal, not from a chat" };
      const key = args[args.indexOf("--rearm") + 1] ?? "", protection = PROTECTIONS[key];
      if (!protection) return { exitCode:1, stderr:`${key || "(no key)"} is not a protection: ${Object.keys(PROTECTIONS).join(", ")}` };
      saveProjectSetting(db, pid, key, protection.armed);
      return { exitCode:0, stdout:JSON.stringify({ ok:true, key, value:protection.armed }) };
    }
    if (args.includes("--renew")) {
      const key = args[args.indexOf("--renew") + 1]!, days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 7, why = args.includes("--why") ? args[args.indexOf("--why") + 1] ?? "" : "";
      const result = renewDisarm(db, pid, key, days, why);
      return "error" in result ? { exitCode:1, stderr:result.error } : { exitCode:0, stdout:JSON.stringify(result.record, null, 2) };
    }
    const settings = loadProjectSettings(db, pid);
    return { exitCode:0, stdout:JSON.stringify(integrityReport(db, settings, pid), null, 2) };
  }
  if (command === "airbag") {
    const [projectId] = args.filter((a) => !a.startsWith("--"));
    if (!projectId) return { exitCode:1, stderr:"usage: bb lane-pilot airbag <project-id> [--prune DAYS] [--probe]" };
    const config = loadPrototypeConfig(db, projectId);
    if (!config) return { exitCode:1, stderr:`project ${projectId} has no configured checkout` };
    const pruneDays = args.includes("--prune") ? Number(args[args.indexOf("--prune") + 1] ?? 14) : 0;
    const probe = args.includes("--probe");
    const script = [
      `git for-each-ref --format='%(refname) %(creatordate:unix) %(objectname)' refs/lane-airbag/`,
      pruneDays > 0 ? `git for-each-ref --format='%(refname) %(creatordate:unix)' refs/lane-airbag/ | awk -v cut=$(( $(date +%s) - ${Math.round(pruneDays) * 86400} )) '$2 < cut {print $1}' | xargs -r -n1 git update-ref -d` : ":",
      probe ? `for r in $(git for-each-ref --format='%(refname)' refs/lane-airbag/); do git cat-file -e "$r" && git cat-file -e "$r^{tree}" && echo "probe ok $r" || echo "probe broken $r"; done` : ":",
    ].join("\n");
    const ran = await host.call("runCommand", { requestedHostId: config.hostId, command: script, cwd: config.writerWorkspacePath, timeoutSec: 60 }, { hostId: config.hostId, timeoutMs: 65_000 });
    return { exitCode:ran.exitCode, stdout:ran.stdout, stderr:ran.stderr || undefined };
  }
  if (command === "pause" && args.length === 1) {
    return { exitCode:0, stdout:JSON.stringify(await pauseRun(ctx, args[0]!, "pause"), null, 2) };
  }
  // `resume <run-id>` lets a paused run go on; `resume [project-id]` is the older reconcile of orphaned writers.
  if (command === "resume" && args.length === 1 && getRun(db, args[0]!)) {
    return { exitCode:0, stdout:JSON.stringify(await pauseRun(ctx, args[0]!, "resume"), null, 2) };
  }
  if (command === "frontmatter") {
    // frontmatter: document header (SMA k_t_frontmatter): read, set and merge a file's header without touching the
    // body. The write goes through a hash guard: a file changed between the read and the write is refused.
    const [projectId, rel, ...rest] = args;
    const config = projectId ? loadPrototypeConfig(db, projectId) : null;
    if (!config || !rel) return { exitCode:1, stderr:"usage: bb lane-pilot frontmatter <project-id> <path> [--set k=v]... [--merge k=a,b]..." };
    const clean = rel.replace(/^\.\//, "");
    if (rel.startsWith("/") || clean.split("/").includes("..")) return { exitCode:1, stderr:"frontmatter: a path outside the project checkout is refused" };
    const quoted = `'${clean.replace(/'/g, `'\\''`)}'`;
    const sets = rest.flatMap((value, index) => value === "--set" && rest[index + 1] ? [rest[index + 1]!] : []);
    const merges = rest.flatMap((value, index) => value === "--merge" && rest[index + 1] ? [rest[index + 1]!] : []);
    const read = await host.call("runCommand", { requestedHostId:config.hostId, command:`cat -- ${quoted}`, cwd:config.writerWorkspacePath, timeoutSec:30 }, { hostId:config.hostId, timeoutMs:35_000 });
    if (read.exitCode !== 0) return { exitCode:1, stderr:`frontmatter: cannot read ${clean}` };
    if (!sets.length && !merges.length) return { exitCode:0, stdout:JSON.stringify(parseFrontmatter(read.stdout)?.data ?? {}) };
    const patch: Record<string, string> = {};
    for (const pair of sets) { const at = pair.indexOf("="); if (at < 1) return { exitCode:1, stderr:`--set expects k=v, got '${pair}'` }; patch[pair.slice(0, at)] = pair.slice(at + 1); }
    const merge: Record<string, string[]> = {};
    for (const pair of merges) { const at = pair.indexOf("="); if (at < 1) return { exitCode:1, stderr:`--merge expects k=a,b, got '${pair}'` }; merge[pair.slice(0, at)] = pair.slice(at + 1).split(",").map((part) => part.trim()).filter(Boolean); }
    const set = setFrontmatter(read.stdout, patch);
    const edited = "refused" in set ? set : mergeFrontmatter(set.content, merge);
    if ("refused" in edited) return { exitCode:1, stderr:edited.refused };
    // the hash is of the text this edit was made from, so a change between the read and the write is caught
    const sha = createHash("sha256").update(read.stdout, "utf8").digest("hex");
    const hashOf = `(sha256sum -- ${quoted} 2>/dev/null || shasum -a 256 -- ${quoted}) | cut -d' ' -f1`;
    const b64 = Buffer.from(edited.content, "utf8").toString("base64");
    const write = await host.call("runCommand", { requestedHostId:config.hostId,
      command:`test ! -L ${quoted} && test "$( ${hashOf} )" = "${sha}" && echo '${b64}' | base64 -d > ${quoted}`,
      cwd:config.writerWorkspacePath, timeoutSec:30 }, { hostId:config.hostId, timeoutMs:35_000 });
    return write.exitCode === 0
      ? { exitCode:0, stdout:`frontmatter: ${clean} written` }
      : { exitCode:1, stderr:`frontmatter: ${clean} changed under the read or the write failed` };
  }
  if (command === "skills") {
    return await runSkillsCli(args);
  }
  if (command === "pm-skills") {
    return runPmSkillsCli(db, args);
  }
  if (command === "pm-skill-use") {
    return runPmSkillUseCli(db, args);
  }
  if (command === "attempt") {
    const result = args[0] ? attemptRecord(db, args[0]) : null;
    return result ? { exitCode:0, stdout:JSON.stringify(result, null, 2) } : { exitCode:1, stderr:"bb lane-pilot attempt <attempt-id>: no such attempt" };
  }
  if (command === "parity") {
    const attemptId = args[0];
    if (!attemptId) return { exitCode:1, stderr:"bb lane-pilot parity <attempt-id>" };
    const session = attemptSessionLayers(db, attemptId);
    const attempt = getAttempt(db, attemptId);
    if (!session || !attempt) return { exitCode:1, stderr:`bb lane-pilot parity ${attemptId}: no such attempt` };
    const projectId = getRun(db, attempt.run_id)?.project_id ?? "";
    const config = projectId ? loadPrototypeConfig(db, projectId) : null;
    let terminalSkills: string[] = [];
    try {
      const out = await spawnAsync(process.env.BB_CLI || "bb", ["tools", "skills-hub", "--json"], { timeout:30_000, maxBuffer:24_000_000 });
      if (out.status === 0) terminalSkills = parseSkillHub(out.stdout).skills.map((skill) => skill.name);
    } catch { /* a terminal without the hub still gets the other five lines */ }
    const terminal = terminalSessionLayers({ db, projectId, skills:terminalSkills, model:config ? `${config.writerProviderId}/${config.writerModel}` : "unknown" });
    const lines = terminalParity(session, terminal);
    if (args.includes("--json")) return { exitCode:0, stdout:JSON.stringify({ attemptId, lines }, null, 2) };
    return { exitCode:0, stdout:lines.map((line) => `${line.same === null ? "n/a " : line.same ? "same" : "DIFF"} ${line.layer}: ${line.detail}`).join("\n") };
  }
  if (command === "stats") {
    // A missing or non-numeric --days is a usage error, not NaN days and an empty report.
    const daysAt = args.indexOf("--days");
    const days = daysAt < 0 ? 30 : /^\d+$/.test(args[daysAt + 1] ?? "") ? Number(args[daysAt + 1]) : NaN;
    if (!Number.isInteger(days) || days < 1) return { exitCode:1, stderr:"bb lane-pilot stats [project] [--days N]: --days takes a whole number of days, 1 or more" };
    const stats = projectStats(db as never, args[0] && !args[0].startsWith("--") ? args[0] : "", days);
    return { exitCode:0, stdout:JSON.stringify(stats, null, 2) };
  }
  if (command === "passport") {
    // --calibration: the badge of the current PM model's forecasts (SMA k_v_passport); it resets when the model changes.
    if (args[0] === "--calibration") {
      const at = args.indexOf("--project");
      if (at < 0 || !args[at + 1]) return { exitCode:1, stderr:"bb lane-pilot passport --calibration --project <id>" };
      return { exitCode:0, stdout:JSON.stringify(calibrationPassport(db, args[at + 1]!), null, 2) };
    }
    const result = args[0] ? passport(db, args[0]) : null;
    return result ? { exitCode:0, stdout:JSON.stringify(result, null, 2) } : { exitCode:1, stderr:"bb lane-pilot passport <attempt-id>: no such attempt" };
  }
  if (command === "manifest") return { exitCode:0, stdout:JSON.stringify(manifest(db), null, 2) };
  if (command === "preship") {
    const result = preship(db, args[0] === "--project" ? args[1] : undefined);
    return { exitCode:result.clear ? 0 : 1, stdout:JSON.stringify(result, null, 2) };
  }
  if (command === "planning") {
    // The planning folder lives in the project's checkout on its own machine: the hub asks that machine, it never opens the path itself.
    const config = args[0] === "verdicts" && args[1] ? loadPrototypeConfig(db, args[1]) : null;
    if (args[0] !== "verdicts" || !args[1]) return { exitCode:1, stderr:"usage: bb lane-pilot planning verdicts <projectId>" };
    if (!config?.hostId || !config.pmWorkspacePath) return { exitCode:1, stderr:`project ${args[1]} has no checkout bound in Lane Pilot` };
    // With a planning home (project.planning_home) the spikes and sketches are listed there; unset, in the checkout.
    const root = await resolvePlanningHome({ host: host as never, hostId:config.hostId, cwd:config.pmWorkspacePath, inputs:planningHomeInputs(db, args[1]), log:bb.log }) ?? config.pmWorkspacePath;
    const listed = await host.call("runCommand", { requestedHostId:config.hostId, command:VERDICT_LIST_COMMAND, cwd:root, timeoutSec:30 }, { hostId:config.hostId, timeoutMs:35_000 });
    if (listed.exitCode !== 0) return { exitCode:1, stderr:`the project's machine did not list .agents/planning: ${(listed.stderr || `exit ${listed.exitCode}`).trim().slice(0, 300)}` };
    return { exitCode:0, stdout:renderVerdicts(verdictInventory(verdictFiles(listed.stdout))) };
  }
  if (command === "explain") {
    const word = args[0];
    // The guide is the plugin's own docs folder, wherever the hub process happens to stand.
    const docs = guideDocs(pluginRootFromModule(import.meta.url));
    if (!word) return { exitCode:1, stderr: `usage: bb lane-pilot explain <verb or topic>\n${explainCatalog(commands, docs).join("  ")}` };
    const hit = explainWord(word, commands, docs);
    if (!hit) return { exitCode:0, stdout:`no explainer for «${word}». Try:\n${explainCatalog(commands, docs).join("\n")}` };
    return { exitCode:0, stdout:`${hit.title} — ${hit.kind}\n\n${hit.text}${hit.source ? `\n\ndoc: ${hit.source}` : ""}` };
  }
  if (command === "money") {
    return { exitCode:0, stdout:JSON.stringify(services.money.status(), null, 2) };
  }
  if (command === "statusline") {
    const hostId = args[0];
    if (!hostId) return { exitCode:1, stderr:"usage: bb lane-pilot statusline <host-id>" };
    const known = await listQaHosts(bb).catch(() => null);
    if (known && !known.some((row) => row.id === hostId)) return { exitCode:1, stderr:`unknown host ${hostId}: ${known.map((row) => row.id).join(", ") || "no machines connected"}` };
    const live = await services.providerUsage?.windows({ providerId:"claude-code", hostId }).catch(() => null);
    return { exitCode:0, stdout:usageSegment(live?.windows ?? {}, live?.at ?? null, Date.now()) };
  }
  if (command === "unknown-codes") {
    const days = args[0] === "--days" && Number(args[1]) > 0 ? Number(args[1]) : 14;
    const rows = listAttemptReasonsSince(db, Date.now() - days * 86_400_000);
    return { exitCode:0, stdout:JSON.stringify(unknownReasons(rows).slice(0, 50), null, 2) };
  }
  return undefined;
}
