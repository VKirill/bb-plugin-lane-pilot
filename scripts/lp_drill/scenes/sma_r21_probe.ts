// Probe of scenes/sma_r21.py (region 21, project queries): runs the REAL verbs and functions of THIS checkout (the commit under drill) on a scratch
// database, a fixture planning folder and a scratch git repo, and prints what they returned as one JSON line. It judges nothing: the scene compares
// every value with the card's expected result and prove()s it. No model, no hub write, nothing outside the machine.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { casUpsertSettings, loadProjectSettings, savePrototypeConfig } from "../../../src/rooms/storage";
import { migrations, openDatabase } from "../../../src/rooms/plugin-db";
import { createCore } from "../../../src/rooms/core/server/core";
import { registerCli } from "../../../src/rooms/tools/server/cli";
import { cliCommands } from "../../../src/rooms/tools/server/cli-commands";
import { runCommandOnHost } from "../../../src/rooms/writer/cli-run";
import { commitDocs } from "../../../src/rooms/docs/git-docs";
import { declaredSkills } from "../../../src/rooms/writer/server/skill-pick";
import { pieceProblems } from "../../../src/rooms/phase/logic/gates";
import { issuable, wavesOf } from "../../../src/rooms/phase/logic/waves";
import { autoInputs } from "../../../src/rooms/phase/server/auto-stages";
import { templateFill } from "../../../src/rooms/phase/stages";
import { featureRegistry, featureRegistryGaps } from "../../../src/rooms/native-install/feature-registry";
import { bundledAgents } from "../../../src/rooms/contracts";
import { resolveRoleModel, ROLE_MODEL_OPTIONS, ROLE_TABLE } from "../../../packages/models/src/role-models";
import { validateSettingValue } from "../../../src/rooms/settings/setting-validation";
import { runCapabilityCli } from "../../../src/rooms/capability/server/cli";
import { createLearning } from "../../../src/rooms/learning/service";
import { runLearningCli } from "../../../src/rooms/learning/cli";
import { codeFactsOnHost } from "../../../src/rooms/platform/code-facts";
import { collectAtlasInput } from "../../atlas-input";
import { capabilitySnapshot } from "../../atlas/logic";
import { REQUIRED_CAPABILITIES } from "../../../src/rooms/native-install/capabilities";
import { STREAMS } from "../../../src/rooms/session-hooks";
import { phaseWorld, seedPhase, STATE, ROADMAP } from "../../../tests/sma/r21-world";

const out: Record<string, unknown> = {};
const piece = (id: string, wave: number, over: Record<string, unknown> = {}) => ({ id, title: id, wave, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: [`acc-${id}`] }, ...over }) as never;

// ---- n1560 / n1561: the entry bb lane-pilot ----
{
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  registerCli(createCore(bb, openDatabase(bb)), {} as never, migrations);
  const unknown = await harness.behavior.runCli(["no-such-verb"]);
  const verbs = cliCommands.map((command) => command.name);
  const status = async () => JSON.parse((await harness.behavior.runCli(["conveyor", "status"])).stdout ?? "{}");
  const before = await status();
  await harness.behavior.runCli(["conveyor", "off", "deploy window"]);
  const during = await status();
  await harness.behavior.runCli(["conveyor", "on"]);
  const after = await status();
  out.entry = { exitCode: unknown.exitCode, verbs: verbs.length, missing: verbs.filter((name) => !new RegExp(`^bb lane-pilot ${name}(\\s|$)`, "m").test(unknown.stderr ?? "")), name: harness.registrations.cli?.name, conveyor: [before.on, during.on, during.reason, after.on] };
}

// ---- the phase verbs on a fixture planning folder ----
{
  const w = phaseWorld();
  const empty = await w.cli("list");
  const a = await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Add the footer", goal: "a footer", roadmapRow: "row-1" });
  const b = await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Fix the header", goal: "a header", roadmapRow: "row-2" });
  const listed = (await w.cli("list")).stdout!.split("\n").sort();
  const third = await w.phases.open({ projectId: "projA", pmThreadId: "t", title: "Three", goal: "g", roadmapRow: "row-1" }).then(() => "opened", (cause: Error) => cause.message);
  await w.cli("pause", a.id);
  const paused = (await w.cli("list")).stdout!.split("\n").sort();
  out.workstream = { empty, listed, a: a.id, b: b.id, third, paused };
}
{
  const w = phaseWorld();
  const id = seedPhase(w);
  const none = await w.cli("state", id);
  const refusedNew = await w.cli("state", id, "--decision", "x");
  w.texts.set(STATE, "---\nphase: 1\nstage: execution\n---\n# State\n\n## Decisions\n- chose sqlite, do not change\n");
  const first = await w.cli("state", id, "--decision", "use WAL", "--blocker", "waits on api");
  const second = await w.cli("state", id, "--decision", "second");
  out.state = { none, refusedNew: { exitCode: refusedNew.exitCode, stderr: refusedNew.stderr }, firstLines: first.stdout!.split("\n"), secondLines: second.stdout!.split("\n"), startsWith: w.texts.get(STATE)!.startsWith("---\nphase: 1\nstage: execution\n") };
  const w2 = phaseWorld();
  const id2 = seedPhase(w2, { id: "ph_road", record: { roadmapRow: "1" } });
  const noFile = await w2.cli("roadmap", id2);
  w2.texts.set(ROADMAP, "- [x] 1 First — g1\n  - note a\n  - note b\n- [ ] 2 Second — g2\n");
  out.roadmap = { noFile: { exitCode: noFile.exitCode, stderr: noFile.stderr }, row: await w2.cli("roadmap", id2, "1"), missing: await w2.cli("roadmap", id2, "9"), analysis: await w2.cli("roadmap", id2), id: id2 };
  // validate
  for (const name of Object.keys(bundledAgents)) w2.texts.set(`.claude/agents/${name}.md`, "agent\n");
  w2.texts.set(ROADMAP, "- [ ] 1 first\n- [ ] 2 second\n- [x] 2 second again\n- [ ] 4 fourth\n");
  const bad = await w2.cli("validate", id2);
  w2.texts.set(ROADMAP, "- [ ] 1 first\n- [ ] 2 second\n");
  out.validate = { bad, good: await w2.cli("validate", id2) };
}
{
  const w = phaseWorld();
  // uat / audit-uat
  const path = ".agents/phases/ph_u/UAT.md";
  const noneOpen = await w.cli("uat");
  const id = seedPhase(w, { id: "ph_u", stage: "acceptance", record: { uat: { path, sha256: "s", at: 1 } } });
  w.texts.set(path, "- [ ] 1. login: not tried\n- [!] 2. reset: breaks\n- [x] 3. logout: works\n");
  const open = await w.cli("uat");
  const yes = () => w.phases.word({ phaseId: id, turn: "uat", decision: "yes", text: "да", by: "owner" });
  const refused = await yes().then(() => "accepted", (cause: Error) => cause.message);
  w.texts.set(path, "- [x] 1. login: works\n- [x] 2. reset: works\n");
  const accepted = await yes().then(() => "accepted", (cause: Error) => cause.message);
  out.uat = { noneOpen, open: { exitCode: open.exitCode, lines: open.stdout!.split("\n").sort() }, id, refused, accepted, after: await w.cli("uat") };
  // verification status
  const next = async (pid: string) => (JSON.parse((await w.cli("show", pid)).stdout!) as { next: { text: string; waitsForPm: boolean } }).next;
  const f = await next(seedPhase(w, { id: "ph_f", stage: "verification", record: { verification: { verdict: { state: "failed", detail: "npm test red", inputSha: "abc", mainSha: null } } } as never }));
  const p = await next(seedPhase(w, { id: "ph_p", stage: "verification", record: { verification: { verdict: { state: "passed", detail: "3 checks green", inputSha: "abc", mainSha: null } } } as never }));
  const n = await next(seedPhase(w, { id: "ph_n", stage: "verification" }));
  out.verification = { failed: { waits: f.waitsForPm, head: f.text.slice(0, 80), returns: f.text.includes('to:"planning"') }, passed: { waits: p.waitsForPm, head: p.text.slice(0, 120) }, none: n };
  // plan gate
  const bad = { ...(piece("p1", 1) as object), task: { id: "other", verification: [], acceptance: [] } };
  const gid = seedPhase(w, { id: "ph_g", stage: "planning", record: { plan: { items: [bad, piece("p2", 1)], contextSha: "ctx", sha: "x", objective: "o", premortem: ["a", "b", "c"] } } as never });
  const gates = (JSON.parse((await w.cli("show", gid)).stdout!) as { gates: { plan: { ok: boolean; why: string[] } } }).gates.plan;
  out.verify = { ok: gates.ok, p1: gates.why.filter((line) => line.startsWith("p1:")), p2: gates.why.filter((line) => line.startsWith("p2:")), sound: pieceProblems(piece("p2", 1)) };
  // lessons
  const lid = seedPhase(w, { id: "ph_l", stage: "lessons", record: { lessons: { why: "closed", draft: { text: "keep the migrations small and reversible", state: "staged", at: 1 } } } as never });
  const learning = createLearning(w.core as never, {} as never);
  const before = JSON.stringify(await learning.run("lessons", { text: "migrations small" })).includes("projA");
  await w.phases.word({ phaseId: lid, turn: "lesson", decision: "yes", text: "да", by: "owner" });
  const rows = w.db.prepare("SELECT project_id, kind, origin, content FROM lane_pilot_memory WHERE origin = 'phase-lessons'").all();
  const found = JSON.stringify(JSON.parse((await runLearningCli(learning, ["lessons", "migrations", "small"])).stdout!));
  out.lessons = { before, rows, listed: found.includes("keep the migrations small and reversible") && found.includes("projA"), draft: (w.db.prepare("SELECT 1").get(), "applied") };
}

// ---- plan inventory, template, inputs ----
{
  const items = [piece("c", 3), piece("a", 1), piece("b", 2), piece("a2", 1)];
  out.waves = { waves: wavesOf(items), issue: issuable(items, {}, new Map()).map((item) => item.id) };
  const phase = { id: "ph_t", title: "Sum", goal: "sums", record: { plan: { items: [piece("a", 1), piece("b", 2)] } } } as never;
  const lines = templateFill("PLAN", phase, new Map()).split("\n");
  out.template = { head: lines.slice(0, 3), a: lines.indexOf("- a: given g; when w; then then-a"), w1: lines.indexOf("### Wave 1"), w2: lines.indexOf("### Wave 2"), owns: lines.includes("  owns: src/**"), checks: lines.includes("  checks: npm test") };
  const draw = { id: "ph_draw", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "g", stage: "design", state: "active", edition: 1, createdAt: 0, updatedAt: 0, record: { design: { decision: "needed", requirements: ["actions", "texts"] }, plan: { items: [piece("p1", 1)] } } } as never;
  const inputs = autoInputs(draw, { kind: "draw" });
  out.init = { goal: inputs.goal, folder: inputs.folder, material: inputs.material, requirements: inputs.requirements, pieces: String(inputs.pieces).includes("p1") };
}

// ---- models, skills, config ----
{
  const tier = (model: string, settings: Record<string, unknown>) => { const r = resolveRoleModel("code-critic", settings); return `${r.providerId}|${r.model}|${r.effort}|${r.source}|${r.sourceKey}${(r as { escalated?: boolean }).escalated ? "|escalated" : ""}`; };
  out.resolve = {
    byDefault: tier("", {}),
    byTable: tier("", { "role_model.code-critic": { model: "claude-opus-5-5", reasoning_effort: "xhigh" } }),
    byStage: tier("", { "code_critique.provider": "codex", "code_critique.model": "gpt-6.1-terra", "code_critique.reasoning_effort": "low" }),
    escalated: tier("", { "code_critique.provider": "codex", "code_critique.model": "gpt-6-luna" }),
  };
  out.catalog = { roles: ROLE_TABLE.length, defaults: Object.fromEntries(["analyst", "planner", "copy-lead", "code-critic", "auditor"].map((role) => { const row = ROLE_TABLE.find((entry) => entry.id === role)!; return [role, `${row.default.model}:${row.default.effort}`]; })), options: ROLE_MODEL_OPTIONS.map((option) => `${option.id}|${option.providerId}|${option.family}|${option.tier}`) };
  const catalog = ["alpha-skill", "beta-skill", "gamma-skill", "delta-skill", "eps-skill", "zeta-skill", "eta-skill", "theta-skill", "iota-skill"].map((name) => ({ name, description: "d" }));
  const nine = catalog.map((entry) => entry.name);
  out.skills = { named: declaredSkills(catalog, ["alpha-skill", "ghost-skill", "alpha-skill", "beta-skill"]), none: declaredSkills(catalog, []), nine: declaredSkills(catalog, nine), expectNine: nine.slice(0, 8) };
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const key = "code_critique.max_rounds";
  const unset = loadProjectSettings(db, "p")[key] ?? null;
  const refused = casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 4, expectedVersion: 0 }] });
  const afterRefused = loadProjectSettings(db, "p")[key] ?? null;
  const saved = casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 2, expectedVersion: 0 }] });
  const stale = casUpsertSettings(db, { projectId: "p", changes: [{ key, value: 3, expectedVersion: 0 }] });
  out.config = { unset, refusedOk: refused.ok, validation: validateSettingValue(key, 4), afterRefused, savedOk: saved.ok, read: loadProjectSettings(db, "p")[key], staleOk: stale.ok, afterStale: loadProjectSettings(db, "p")[key] };
}

// ---- a scratch git repo: commit by list, code facts ----
{
  const root = mkdtempSync(join(tmpdir(), "lp-r21-scene-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(root, ".agents/planning"), { recursive: true });
  writeFileSync(join(root, "README.md"), "base\n"); git("add", "."); git("commit", "-q", "-m", "base");
  writeFileSync(join(root, ".agents/planning/STATE.md"), "state\n");
  writeFileSync(join(root, "other.ts"), "not mine\n");
  const empty = await commitDocs({ projectCwd: root, paths: [], message: "docs: none" });
  const done = await commitDocs({ projectCwd: root, paths: [".agents/planning/STATE.md"], message: "docs: state" });
  out.commit = { empty, status: done.status, head: done.commit === git("rev-parse", "HEAD"), subject: git("log", "-1", "--format=%s"), files: git("show", "--name-only", "--format=", "HEAD"), rest: git("status", "--short"), again: (await commitDocs({ projectCwd: root, paths: [".agents/planning/STATE.md"], message: "docs: again" })).status, count: git("rev-list", "--count", "HEAD") };
  // intel: .gitnexus/meta.json names the commit the index was built at
  const host = { call: async (_method: string, input: { command: string; cwd: string }) => runCommandOnHost({ requestedHostId: "h", command: input.command, cwd: input.cwd }) };
  const none = await codeFactsOnHost(host as never, "h", root);
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(root, "a.txt"), "1\n"); git("add", "."); git("commit", "-q", "-m", "c2");
  writeFileSync(join(root, "b.txt"), "2\n"); git("add", "."); git("commit", "-q", "-m", "c3");
  mkdirSync(join(root, ".gitnexus"));
  writeFileSync(join(root, ".gitnexus/meta.json"), JSON.stringify({ lastCommit: first }));
  const stale = await codeFactsOnHost(host as never, "h", root);
  writeFileSync(join(root, ".gitnexus/meta.json"), JSON.stringify({ lastCommit: git("rev-parse", "HEAD") }));
  out.intel = { none, stale, fresh: await codeFactsOnHost(host as never, "h", root) };
  // frontmatter: the verb writes the header of a real file
  const dir = mkdtempSync(join(tmpdir(), "lp-r21-front-"));
  const file = join(dir, "page.md");
  writeFileSync(file, "---\ntitle: \"A: b\"\n# why\ntags: [x]\n---\n\n# Body\n");
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  savePrototypeConfig(db, { projectId: "p1", hostId: "h", pmWorkspacePath: dir, writerWorkspacePath: dir, pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "m" } as never);
  const core = createCore(bb, db) as unknown as { host: unknown };
  core.host = { call: async (_method: string, input: Parameters<typeof runCommandOnHost>[0]) => runCommandOnHost(input) };
  registerCli(core as never, {} as never, migrations);
  const run = (...args: string[]) => harness.behavior.runCli(["frontmatter", "p1", ...args]);
  const read = await run("page.md");
  const wrote = await run("page.md", "--set", "status=done", "--merge", "tags=y");
  out.frontmatter = { read: JSON.parse(read.stdout ?? "null"), wrote: wrote.exitCode, text: readFileSync(file, "utf8"), outside: (await run("../x.md", "--set", "a=b")).exitCode };
}

// ---- the registry, the atlas snapshot, the capabilities verb ----
{
  const registry = featureRegistry();
  const agents = bundledAgents as Record<string, { skills?: string[] }>;
  out.capreg = {
    ids: registry.map((feature) => feature.id).join(",") === [...Object.keys(agents), "session-guard"].join(","),
    perAgent: Object.entries(agents).every(([id, agent]) => { const f = registry.find((entry) => entry.id === id)!; return JSON.stringify(f.agents) === JSON.stringify({ claude: [id], opencode: [id] }) && JSON.stringify(f.skills.claude) === JSON.stringify(agent.skills ?? []); }),
    gaps: featureRegistryGaps(registry),
    broken: featureRegistryGaps([...registry, { id: "made-up", agents: { claude: ["no-such-agent"] }, skills: { opencode: ["no-such-skill"] }, hooks: { claude: ["no-such-hook"] } }]),
    agents: Object.keys(agents).length,
  };
  const root = join(import.meta.dirname, "..", "..", "..");
  const input = collectAtlasInput(root);
  out.capgen = { same: readFileSync(join(root, "docs", "capabilities.snapshot.json"), "utf8") === capabilitySnapshot(input, [...STREAMS], REQUIRED_CAPABILITIES), count: input.capabilities.length, ids: input.capabilities.map((row) => row.id).join(",") === registry.map((row) => row.id).join(",") };
  const table = (state: string) => [{ providerId: "codex", version: "0.1.0", capabilities: { answers: "supported", pause: state } }];
  const api = (rows: unknown) => ({ table: async () => rows, sweep: async () => [{ providerId: "codex", capability: "answers", state: "supported" }] }) as never;
  const ok = await runCapabilityCli(api(table("supported")), []);
  const red = await runCapabilityCli(api(table("not_supported")), []);
  const unproven = await runCapabilityCli(api(table("unproven")), []);
  out.capstate = { ok: [ok.exitCode, JSON.parse(ok.stdout!).table[0].capabilities], red: [red.exitCode, JSON.parse(red.stdout!).table[0].capabilities], unproven: unproven.exitCode, bogus: (await runCapabilityCli(api([]), ["--bogus"])).exitCode };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
