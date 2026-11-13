import type { PluginCliResult } from "@get-bb/plugin-sdk";
import type { CliRunDeps } from "./cli-deps";
import { EXCAVATE_LOG_ARGS, approvalSuggestions, costPerVerified, excavate, htmlReport, missCurriculum } from "./self-improve";
import { GLOBAL_SETTINGS_PROJECT_ID, PAIR_ROLE_SPECS, PROFILE_KEYS, RUN_BUDGET_SETTINGS, UNLISTED_SWITCHES, attemptMetrics, bestEffort, cancelAttemptById, casUpsertSettings, configuredSetting, deleteBoundSetting, failureFieldsOf, finishRunSafely, getActivation, getAttempt, getCouncilSession, getRun, getSettingVersions, getTask, inspectAttempt, inspectState, isNotFound, join, listRunsWithAttempts, listSettingRows, loadProjectSettings, loadPrototypeConfig, memoryCompressChanges, orMiss, planningHomeInputs, profilePairProblem, prototypeConfigSchema, renderAttemptMetrics, resolvePlanningHome, runCatalogCli, runHealth, runMemoryCompressCli, runMemoryConflictCli, runMemoryEvalCommand, saveProjectSetting, savePrototypeConfig, stringAt, switchValue, taskV2Schema, transitionAttempt, valueAt } from "./cli-imports";
/** Project, council, harness, run and probe commands of `bb lane-pilot`. Returns undefined when `command` is not one of theirs. */
export async function cliProject(d: CliRunDeps): Promise<PluginCliResult | undefined> {
  const { bb, db, effectiveProjectSettings, host } = d.ctx;
  const { ctx, services, command, args, invocation, commands, migrations } = d;

  if (command === "configure" && args.length === 1) {
    const config = prototypeConfigSchema.parse(JSON.parse(args[0]!));
    savePrototypeConfig(db, config);
    return { exitCode:0, stdout:JSON.stringify({ ok:true, projectId:config.projectId }) };
  }
  if (command === "activate" && args.length >= 2) {
    return { exitCode:0, stdout:JSON.stringify(await services.activate(args[0]!, args[1]!, args[2] === "cli" ? "cli" : "bb")) };
  }
  if (command === "setting") {
    const [scope, ...pairs] = args;
    const where = scope === "global" ? GLOBAL_SETTINGS_PROJECT_ID : scope;
    if (!where) return { exitCode:0, stdout:Object.entries(UNLISTED_SWITCHES).map(([key, [level, values, what]]) => `${key} (${level}; ${values}): ${what}`).join("\n") };
    const own = () => Object.fromEntries(listSettingRows(db, where).filter((row) => row.key in UNLISTED_SWITCHES).map((row) => [row.key, row.value]));
    if (!pairs.length) return { exitCode:0, stdout:JSON.stringify({ scope:scope!, set:own() }, null, 2) };
    // A switch changes what the machine does by itself, some of them spend money: an agent's shell never flips one.
    if (invocation?.threadId) return { exitCode:1, stdout:JSON.stringify({ ok:false, error:"a setting is set by the owner at a terminal, not from a chat: ask them to run this command" }) };
    const changes: Array<{ key:string; value:unknown }> = [];
    for (const pair of pairs) {
      const at = pair.indexOf("=");
      const key = at < 0 ? pair : pair.slice(0, at);
      const known = UNLISTED_SWITCHES[key];
      if (at < 0 || !known) throw new Error(known ? `write ${key}=<value>` : `${key} is not on the list; \`bb lane-pilot setting\` prints it (a setting with a row in the settings window is set there)`);
      if (known[0] === "global" && where !== GLOBAL_SETTINGS_PROJECT_ID) throw new Error(`${key} is read hub-wide only: bb lane-pilot setting global ${pair}`);
      if (known[0] === "project-only" && where === GLOBAL_SETTINGS_PROJECT_ID) throw new Error(`${key} is read from a project's own row only: name the project`);
      const text = pair.slice(at + 1);
      if (text === "") { changes.push({ key, value:undefined }); continue; }
      const parsed = switchValue(key, text);
      if ("problem" in parsed) throw new Error(parsed.problem);
      changes.push({ key, value:parsed.value });
    }
    const cleared = changes.filter((change) => change.value === undefined).map((change) => change.key);
    const kept = changes.filter((change) => change.value !== undefined);
    const versions = getSettingVersions(db, where, kept.map((change) => change.key));
    const saved = kept.length ? casUpsertSettings(db, { projectId:where, bindingId:"", changes:kept.map((change) => ({ ...change, expectedVersion:versions[change.key] ?? 0 })) }) : null;
    if (saved && !saved.ok) return { exitCode:1, stdout:JSON.stringify({ ok:false, error:saved.validation ?? "the setting changed meanwhile: run the command again" }) };
    for (const key of cleared) deleteBoundSetting(db, where, key);
    return { exitCode:0, stdout:JSON.stringify({ ok:true, scope:scope!, set:own() }, null, 2) };
  }
  // The one infra-profile writer and reader (SMA k_pl_infra): the eight profile.* settings of a project.
  if (command === "profile") {
    const [projectId, ...rest] = args;
    if (!projectId) return { exitCode:1, stderr:`usage: bb lane-pilot profile <project-id> [--set key=value …]   (keys: ${PROFILE_KEYS.join(", ")}; an empty value resets the key)` };
    const sets = rest.flatMap((value, index) => value === "--set" && rest[index + 1] !== undefined ? [rest[index + 1]!] : []);
    if (sets.length) {
      // The CLI is a door any agent thread can reach: from a thread only the PM chat of THIS project writes the profile; the owner at a terminal always may.
      if (invocation?.threadId) {
        const caller = await orMiss(bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound) as { projectId?: unknown } | null;
        if (!caller || typeof caller.projectId !== "string" || caller.projectId !== projectId) return { exitCode:1, stderr:`refused: the profile of ${projectId} is set from that project's own PM chat or by the owner at a terminal, not from a thread of ${typeof caller?.projectId === "string" ? caller.projectId : "an unknown project"}` };
        const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: invocation.threadId }), null, isNotFound) as { role?: unknown } | null;
        if (metadata?.role !== "pm") return { exitCode:1, stderr:`refused: the profile is set by the PM chat or the owner, not by a ${typeof metadata?.role === "string" ? `${metadata.role} thread` : "thread whose role is unknown"}` };
      }
      // All pairs are judged before any is written: one refused pair stops the call with its reason and nothing changes.
      const parsed = sets.map((pair) => { const at = pair.indexOf("="); return at < 0 ? { key: pair, value: null as string | null } : { key: pair.slice(0, at), value: pair.slice(at + 1) }; });
      for (const { key, value } of parsed) {
        if (value === null) return { exitCode:1, stderr:`write ${key}=<value> (an empty value resets the key)` };
        const problem = value === "" && (PROFILE_KEYS as readonly string[]).includes(key) ? null : profilePairProblem(key, value);
        if (problem) return { exitCode:1, stderr:`refused ${key}: ${problem}` };
      }
      for (const { key, value } of parsed) { if (value === "") deleteBoundSetting(db, projectId, `profile.${key}`); else saveProjectSetting(db, projectId, `profile.${key}`, value); }
    }
    const settings = loadProjectSettings(db, projectId);
    const values = Object.fromEntries(PROFILE_KEYS.map((key) => [`profile.${key}`, typeof settings[`profile.${key}`] === "string" ? settings[`profile.${key}`] as string : ""]));
    if (Object.values(values).some((value) => value !== "")) return { exitCode:0, stdout:JSON.stringify(values, null, 2) };
    // The settings are empty: a profile.json an earlier start left in the planning folder still answers, and says where the values come from.
    const config = loadPrototypeConfig(db, projectId);
    if (config?.hostId && config.pmWorkspacePath) {
      const root = await resolvePlanningHome({ host: host as never, hostId:config.hostId, cwd:config.pmWorkspacePath, inputs:planningHomeInputs(db, projectId), log:bb.log }) ?? config.pmWorkspacePath;
      const file = await host.call("runCommand", { requestedHostId:config.hostId, command:"cat .agents/planning/profile.json 2>/dev/null", cwd:root, timeoutSec:15 }, { hostId:config.hostId, timeoutMs:20_000 }).catch(() => null);
      let fromFile: Record<string, unknown> = {};
      try { const parsedFile: unknown = JSON.parse(file?.stdout ?? ""); if (parsedFile && typeof parsedFile === "object" && !Array.isArray(parsedFile)) fromFile = parsedFile as Record<string, unknown>; } catch { /* no file, or not JSON */ }
      const shown = Object.fromEntries(PROFILE_KEYS.flatMap((key) => (typeof fromFile[key] === "string" && fromFile[key] ? [[`profile.${key}`, fromFile[key]]] : [])));
      if (Object.keys(shown).length) return { exitCode:0, stdout:JSON.stringify({ ...values, ...shown, source:`the project settings are empty: these values come from .agents/planning/profile.json (set them with --set to move them into the settings)` }, null, 2) };
    }
    return { exitCode:0, stdout:JSON.stringify(values, null, 2) };
  }
  // The planning files' integrity (SMA k_c_health): the todos and plans indexes against the folders on disk; --fix repairs the index lines only.
  if (command === "plans-health") {
    // --fix rewrites index files on the machine the command runs on: the owner's terminal, never an agent thread.
    if (args.includes("--fix") && invocation?.threadId) return { exitCode:1, stderr:"refused: plans-health --fix rewrites the index files of the directory it runs in; the owner runs it at a terminal in the checkout" };
    const { plansHealth, plansFix } = await import("../../project-life");
    const dir = args.find((arg) => !arg.startsWith("--")) ?? process.cwd();
    const agentsDir = dir.endsWith(".agents") ? dir : `${dir.replace(/\/$/, "")}/.agents`;
    const report = plansHealth(agentsDir);
    const fixed = args.includes("--fix") ? plansFix(agentsDir) : [];
    const lines = report.flatMap((area) => [...area.missingInIndex.map((id) => `${area.area}: not in INDEX.md: ${id}`), ...area.deadIndexLines.map((line) => `${area.area}: INDEX line with no folder: ${line.trim().slice(0, 120)}`)]);
    return { exitCode: report.length && !fixed.length ? 1 : 0, stdout: [...lines, ...fixed.map((line) => `fixed ${line}`)].join("\n") || "planning indexes healthy" };
  }
  if (command === "budget" && args.length >= 1) {
    const projectId = args[0]!;
    for (const pair of args.slice(1)) {
      const [key, value = ""] = pair.split("=", 2) as [string, string?];
      if (!(RUN_BUDGET_SETTINGS as readonly string[]).includes(key)) throw new Error(`unknown budget setting ${key}; use ${RUN_BUDGET_SETTINGS.join(", ")}`);
      if (value !== "" && !/^\d+$/.test(value)) throw new Error(`${key} must be a positive integer or empty`);
      saveProjectSetting(db, projectId, key, value);
    }
    const settings = loadProjectSettings(db, projectId);
    return { exitCode:0, stdout:JSON.stringify({ projectId, budget:Object.fromEntries(RUN_BUDGET_SETTINGS.map((key) => [key, settings[key] ?? ""])) }, null, 2) };
  }
  if (command === "council" && args.length >= 2) {
    const run = getRun(db, args[0]!);
    if (!run || !run.pm_thread_id || run.closed_at) throw new Error("run must be open and have a PM thread");
    const options = Object.fromEntries(args.slice(2).filter((arg) => arg.includes("=")).map((arg) => arg.split("=", 2) as [string, string]));
    const session = await services.council.startCouncil({
      projectId: run.project_id, runId: run.id, pmThreadId: run.pm_thread_id, question: args[1]!,
      roles: options.roles ? options.roles.split(",") : undefined, maxRounds: options.rounds ? Number(options.rounds) : undefined,
      mode: options.mode === "rounds" ? "rounds" : options.mode === "room" ? "room" : undefined,
      materials: options.materials ? options.materials.split(",") : undefined,
    });
    return { exitCode:0, stdout:JSON.stringify({ id: session.id, state: session.state, seats: session.seats.map((seat) => `${seat.id}:${seat.providerId}/${seat.model}`) }, null, 2) };
  }
  if (command === "council-say" && args.length >= 1) {
    const text = args.slice(1).filter((arg) => !/^decide=/.test(arg)).join(" ").trim();
    const decide = args.some((arg) => /^decide=(1|true|yes)$/.test(arg));
    const said = text ? services.council.say(args[0]!, text) : null;
    const decided = decide ? services.council.requestDecision(args[0]!) : null;
    return { exitCode:0, stdout:JSON.stringify({ said: said ? said.seq : null, decideRequested: Boolean(decided) }) };
  }
  if (command === "council-seats" && args.length === 1) {
    const settings = (await effectiveProjectSettings(args[0]!)).values;
    const keys = PAIR_ROLE_SPECS.flatMap((spec) => [spec.keys[0], spec.keys[1]]);
    return { exitCode:0, stdout:JSON.stringify({ ...await services.council.seatDefaults(args[0]!), settings: Object.fromEntries(keys.map((key) => [key, configuredSetting(settings, key) ?? null])) }, null, 2) };
  }
  if (command === "council-status" && args.length >= 1) {
    const found = getCouncilSession(db, args[0]!);
    if (!found) throw new Error("council not found");
    return { exitCode:0, stdout:JSON.stringify(services.council.councilView(found, args[1] ? Number(args[1]) : 0), null, 2) };
  }
  if (command === "harness" && args.length === 1) {
    return { exitCode:0, stdout:JSON.stringify(await services.harness.status(args[0]!), null, 2) };
  }
  if (command === "harness-edit" && args.length >= 1 && args.length <= 4) {
    const wait = args.includes("wait=1");
    const plain = args.filter((arg) => arg !== "wait=1");
    const run = services.harness.runEditor({ projectId:plain[0]!, area:plain[1] ?? "", writerKey:plain[2] ?? "*", reason:"cli" });
    if (!wait) { void bestEffort(bb.log, "harness editor background run", run, undefined); return { exitCode:0, stdout:JSON.stringify({ status:"started", detail:"running in the background; bb lane-pilot harness <project-id> shows the trial when it lands" }, null, 2) }; }
    return { exitCode:0, stdout:JSON.stringify(await run, null, 2) };
  }
  if (command === "harness-trajectory" && (args.length === 1 || args.length === 2)) {
    const result = await services.harness.trajectory(args[0]!, args[1]);
    return { exitCode:0, stdout:`# ${result.events} events, ${result.sliced} in the slice\n\n${result.text}` };
  }
  if (command === "harness-tick" && args.length >= 1 && args.length <= 2) {
    return { exitCode:0, stdout:JSON.stringify(await services.harness.tick(args[0]!, { dryRun:args[1] === "dry=1" }), null, 2) };
  }
  if (command === "metrics" && args.length >= 1) {
    const projectId = args[0]!;
    const flag = (name:string) => args.indexOf(name);
    const at = flag("--days");
    const days = at >= 0 ? Number(args[at + 1]) : 7;
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days must be an integer from 1 to 90");
    const report = attemptMetrics(db, { projectId, days });
    return { exitCode:0, stdout:flag("--json") >= 0 ? JSON.stringify(report, null, 2) : renderAttemptMetrics(report) };
  }
  if (command === "health" && args.length <= 1) {
    const runIds = args[0] ? [args[0]] : [...services.runBudgets.keys()];
    return { exitCode:0, stdout:JSON.stringify({ providers:services.providerBreaker.snapshot(), runs:runIds.map((runId) => runHealth(services, runId)) }, null, 2) };
  }
  if (command === "state" && args.length >= 1 && args.length <= 5) {
    const opt = (name:string) => { const at = args.indexOf(name); return at > 0 ? args[at + 1] : undefined; };
    const attemptId = opt("--attempt");
    if (attemptId) {
      const reasonOffset = Number(opt("--reason-offset") ?? 0);
      if (!Number.isSafeInteger(reasonOffset) || reasonOffset < 0) throw new Error("--reason-offset must be a non-negative integer");
      const attempt = inspectAttempt(db, args[0]!, attemptId, reasonOffset);
      if (!attempt) throw new Error(`no attempt ${attemptId} in project ${args[0]}`);
      return { exitCode:0, stdout:JSON.stringify(attempt, null, 2) };
    }
    const number = (name:string, max:number) => { const raw = opt(name); if (raw === undefined) return undefined; const n = Number(raw); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer from 1 to ${max}`); return n; };
    const limit = number("--limit", 100);
    const cursor = opt("--before")?.split(":");
    const before = cursor ? Number(cursor[0]) : undefined;
    if (cursor && (cursor.length > 2 || !Number.isSafeInteger(before) || before! < 1 || (cursor.length === 2 && !cursor[1]))) throw new Error("--before must be a timestamp or timestamp:id cursor from state.next");
    const beforeId = cursor?.[1] ? decodeURIComponent(cursor[1]) : undefined;
    return { exitCode:0, stdout:JSON.stringify(inspectState(db, args[0]!, { ...(limit ? { limit } : {}), ...(before ? { before } : {}), ...(beforeId ? { beforeId } : {}) }), null, 2) };
  }
  if ((command === "finish" || command === "deactivate") && (args.length === 1 || args.length === 2)) {
    const projectId = args[0]!;
    const runs = listRunsWithAttempts(db, projectId).filter((run) => !run.closed_at);
    const activation = getActivation(db, projectId);
    const runId = args[1] ?? (activation?.run_id && runs.some((run) => run.id === activation.run_id)
      ? activation.run_id
      : runs.length === 1 ? runs[0]!.id : null);
    if (!runId) {
      if (!runs.length) return { exitCode:0, stdout:JSON.stringify({ projectId, finishedRunIds:[], closed:true }) };
      throw new Error("specify a run id when the project has multiple open runs");
    }
    await finishRunSafely(bb, db, projectId, runId, "cli");
    return { exitCode:0, stdout:JSON.stringify({ projectId, finishedRunIds:[runId], closed:true }) };
  }
  if (command === "cancel" && args.length === 1) {
    // One road for every cancel (the PM's tool, the board's RPC, this command): a queued attempt at once, a running one once its
    // writer's stop is observed, a task that ended blocked by closing it.
    const result = await cancelAttemptById(ctx, args[0]!, services.rollback, "canceled from the CLI", "owner_cancel");
    return { exitCode:result.ok ? 0 : 1, stdout:JSON.stringify({ attemptId:args[0], ...result }) };
  }
  if (command === "recover" && args.length === 1) {
    const attempt = getAttempt(db, args[0]!);
    if (!attempt) throw new Error("attempt does not exist");
    const run = getRun(db, attempt.run_id);
    if (!run?.pm_thread_id) throw new Error("attempt run has no PM thread");
    const writerThreadId = await services.reconcileAttemptThread(run.project_id, attempt);
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId:writerThreadId });
    if (valueAt(metadata, "lanePilotRunId") !== attempt.run_id
      || valueAt(metadata, "lanePilotTaskId") !== attempt.task_id
      || valueAt(metadata, "attemptId") !== attempt.id) {
      transitionAttempt(db, attempt.id, "blocked", { threadId:writerThreadId, reason:"idempotency triple mismatch" });
      throw new Error("writer metadata does not match the persisted idempotency triple");
    }
    const thread = await bb.sdk.threads.get({ threadId:writerThreadId });
    if (stringAt(thread, "status") !== "idle") throw new Error(`writer is not idle: ${stringAt(thread, "status") ?? "unknown"}`);
    const config = loadPrototypeConfig(db, run.project_id);
    if (!config) throw new Error("prototype configuration is missing");
    const savedTask = getTask(db, attempt.task_id);
    if (!savedTask) throw new Error(`reconciled task missing: ${attempt.task_id}`);
    const recoveredTask = taskV2Schema.parse(savedTask.contract);
    const checked = await services.validateWriterResult({
      config, projectId:run.project_id, runId:attempt.run_id, taskId:attempt.task_id,
      attempt:attempt.attempt_no, task:recoveredTask, writerThreadId, attemptId:attempt.id,
      dirtBefore:attempt.dirt_before,
    });
    if (checked.status !== "accepted") {
      transitionAttempt(db, attempt.id, checked.status, { threadId:writerThreadId, reason:checked.reason ?? checked.status, ...failureFieldsOf(checked) });
      throw new Error(`reconciled writer validation failed: ${checked.reason ?? checked.status}`);
    }
    const receipt = await services.persistWriterAcceptance({
      config, task:recoveredTask, runId:attempt.run_id,
      taskId:attempt.task_id, attempt:attempt.attempt_no, attemptId:attempt.id,
      pmThreadId:run.pm_thread_id, writerThreadId, output:checked.output, verification:checked.verification,
    });
    transitionAttempt(db, attempt.id, "accepted", { threadId:writerThreadId });
    return { exitCode:0, stdout:JSON.stringify(receipt, null, 2) };
  }
  if (command === "start-cancel-probe" && args.length === 2) {
    return { exitCode:0, stdout:JSON.stringify(await services.startCancelProbe(args[0]!, args[1]!), null, 2) };
  }
  if (command === "start-provider-error-probe" && args.length === 2) {
    return { exitCode:0, stdout:JSON.stringify(await services.startProviderErrorProbe(args[0]!, args[1]!), null, 2) };
  }
  if (command === "helper-probe" && args.length === 4) {
    const probe = await services.startHelperProbe(args[0]!, args[1]!, args[2]!, args[3]!);
    return { exitCode:probe.ok ? 0 : 1, stdout:JSON.stringify(probe, null, 2) };
  }
  if (command === "memory-probe" && args.length >= 1) {
    const flags = args.slice(1);
    const has = (name: string) => flags.includes(`--${name}`);
    const paths = flags.find((flag) => flag.startsWith("--paths="))?.slice("--paths=".length) ?? (flags.includes("--paths") ? flags[flags.indexOf("--paths") + 1] : undefined);
    if (has("clean")) return { exitCode:0, stdout:JSON.stringify({ removed:services.memoryProbe.clean(args[0]!) }, null, 2) };
    if (has("report")) return { exitCode:0, stdout:JSON.stringify(services.memoryProbe.report(args[0]!), null, 2) };
    const probe = await services.memoryProbe.run({ projectId:args[0]!, paths:paths ? paths.split(",").map((item) => item.trim()).filter(Boolean) : undefined, keep:has("keep"), force:has("force") });
    return { exitCode:probe.ok ? 0 : 1, stdout:JSON.stringify(probe, null, 2) };
  }
  if (command === "memory-eval") {
    // `--e2e` asks a model one question at a time the way the learning review does: the project's rules analyzer, a hidden thread on the project's machine.
    const model = (projectId: string) => async (prompt: string, label: "answer" | "judge", caseId: string): Promise<string> => {
      const place = await services.resolveProjectWriterHost({ projectId } as never).catch(() => null) as { status?: string; hostId?: string; path?: string } | null;
      if (!place || place.status !== "resolved" || !place.hostId || !place.path) throw new Error("no_host");
      const analyzer = await services.ruleScan.analyzerFor(projectId, { hostId: place.hostId, path: place.path });
      if (!analyzer) throw new Error("no_analyzer_model");
      return await services.ruleScan.runAnalyzer(projectId, `Memory eval · ${label} · ${caseId}`.slice(0, 160), prompt, { hostId: place.hostId, path: place.path }, analyzer, { learning: true });
    };
    return await runMemoryEvalCommand(db, args, migrations, { northStar: () => costPerVerified(db), model });
  }
  if (command === "memory-conflicts" || command === "memory-conflict-settle") {
    return runMemoryConflictCli(services.memoryConflicts, command, args);
  }
  if (command === "memory-compress") {
    // Listing proposals is for the owner and for a PM chat in its own project. --apply and --undo change the corpus: the owner's alone (no thread).
    let compressArgs = args;
    if (invocation?.threadId) {
      if (memoryCompressChanges(args)) return { exitCode:1, stderr:"refused: memory-compress --apply and --undo change the project's memory and are the owner's alone; run them at a terminal. A thread may only list the proposals" };
      const caller = await orMiss(bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound) as { projectId?: unknown } | null;
      const own = typeof caller?.projectId === "string" ? caller.projectId : null;
      const at = args.indexOf("--project");
      const asked = at >= 0 ? args[at + 1] : own;
      if (!own || asked !== own) return { exitCode:1, stderr:`refused: memory-compress from a thread reaches only that thread's own project (${own ?? "unknown"}), not ${asked ?? "none"}` };
      const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: invocation.threadId }), null, isNotFound) as { role?: unknown } | null;
      if (metadata?.role !== "pm") return { exitCode:1, stderr:`refused: memory-compress is not for a ${typeof metadata?.role === "string" ? `${metadata.role} thread` : "thread whose role is unknown"}; ask the PM or the owner` };
      if (at < 0) compressArgs = [...args, "--project", own];
    }
    return runMemoryCompressCli(db as never, compressArgs);
  }
  if (command === "catalog") {
    // The verb reads files of the machine the hub runs on: a chat on another machine must not read the hub's folders through it.
    if (invocation?.threadId) return { exitCode:1, stderr:"refused: catalog reads folders of the hub machine and is for the owner at a terminal; a session builds its own catalog at start" };
    return runCatalogCli(args);
  }
  if (command === "start-ambiguous-probe" && args.length === 2) {
    return { exitCode:0, stdout:JSON.stringify(await services.startAmbiguousProbe(args[0]!, args[1]!), null, 2) };
  }
  return undefined;
}
