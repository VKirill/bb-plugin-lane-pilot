import { noteEngineWrite } from "../../verification/server";
import { listOpenAttempts, loadProjectSettings } from "../../storage";
import { isPlanningPath } from "../../contracts";
import { PROFILE_KEYS } from "../../anamnesis";
import { bestEffort, sha256Hex } from "@lane-pilot/kit";
import { list, rec, str, pmCheckout, quote, PRUNE } from "./workflow-chain-runtime";
import type { Row } from "./workflow-chain-runtime";
import type { GraphNode, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { runOnHost } from "@lane-pilot/host-calls";
import { oneLine, ownsPathProblems, parkRoadmapRow } from "../../phase";
import type { ChainRuntime } from "../../contracts/server";
import type { ServerCore } from "../../contracts/server";

type Action = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;
type PlanHome = (projectId: string, checkout: { hostId: string; path: string }) => Promise<string | null>;
type FlagOf = (rt: ChainRuntime, key: string) => boolean;

// ---------------------------------------------------------------- actions on the plugin's own state and the PM's checkout

/** The actions that read the PM's checkout or write into it: files, diffs, the state probe, the roadmap's parking lot, the tree counts. */
export function registerCheckoutActions(engine: WorkflowEngine, ctx: ServerCore, deps: {
  action: Action;
  planHome: PlanHome;
  flagOf: FlagOf;
}): void {
  const { bb, db } = ctx;
  const { action, planHome, flagOf } = deps;

  action("fs.write", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = node.params as Row;
    const checkout = await pmCheckout(rt);
    const rel = c.render(str(params.path)).replace(/^\/+/, "");
    if (!rel || rel.includes("..") || rel.includes("\0")) throw new Error(`fs.write: the path "${rel}" is not inside the checkout`);
    const isFolder = rel.endsWith("/");
    // A planning file (.agents/phases|planning|todos|plans, not a task's own folder) goes to the planning home when the project set one (SMA d_project_planning); unset, the checkout.
    const home = isPlanningPath(rel) ? await planHome(rt.projectId, checkout) : null;
    const write = async (path: string, content: string) => {
      if (home) { await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: home, path: `${home}/${path}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null }); return; }
      // Noted before the write lands, so a helper's status read right after it already sees it as the engine's.
      noteEngineWrite(checkout.path, path);
      await bb.sdk.files.write({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${path}`, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
    };
    const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
    let first = rel;
    if (params.contents && typeof params.contents === "object") {
      for (const [name, template] of Object.entries(params.contents as Row)) { const value = c.template(template); await write(`${rel}${name}`, asText(value ?? "")); first = first === rel ? `${rel}${name}` : first; }
    } else if (!isFolder) {
      await write(rel, asText(reportBody(c, params)));
    }
    const out: Row = {};
    for (const field of c.node.out) {
      if (field.name === "folder") out.folder = isFolder ? rel : rel.slice(0, rel.lastIndexOf("/") + 1) || "./";
      else if (field.name === "handoff_path") out.handoff_path = isFolder ? `${rel}handoff.md` : rel;
      else if (field.name.endsWith("_path")) out[field.name] = isFolder && !params.contents ? rel : first;
    }
    return out;
  });

  /** A file the chain writes: JSON of what it `reads`, else a Markdown report of the run so far. */
  function reportBody(c: StepContext<ChainRuntime>, params: Row): unknown {
    const reads = list(rec(c.node).reads).map(String);
    if (reads.length) return Object.fromEntries(reads.map((ref) => [ref.split(".").pop()!, c.resolve(ref)]));
    const rows = c.workflow.nodes.filter((node) => node.type !== "note" && node.id !== c.nodeId).map((node) => [node.id, c.resolve(node.id)] as const).filter(([, value]) => value !== undefined && Object.keys(rec(value)).length);
    return [`# ${c.workflow.name.en}`, "", str(params.template) ? `Contents: ${str(params.template)}.` : "", ...rows.flatMap(([id, value]) => ["", `## ${id}`, "```json", JSON.stringify(value, null, 1).slice(0, 12_000), "```"])].join("\n");
  }

  action("git.diff_files", async (c, rt) => {
    const checkout = await pmCheckout(rt);
    const files = c.resolve("$inputs.files"), range = c.resolve("$inputs.range"), pr = str(c.resolve("$inputs.pr"));
    let names: string[] = [];
    if (Array.isArray(files) && files.length) names = files.map(String);
    else {
      const command = Array.isArray(range) && range.length ? `git show --name-only --format= ${range.map((commit) => quote(String(commit))).join(" ")}`
        : typeof range === "string" && range ? `git diff --name-only ${quote(range)}` : pr ? `gh pr diff ${quote(pr)} --name-only` : "";
      if (command) {
        const ran = await runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command, timeoutSec: 60, timeoutMs: 75_000 });
        if (ran.exitCode !== 0) throw new Error(`git.diff_files: ${ran.stderr.trim().slice(0, 300) || `exit ${ran.exitCode}`}`);
        names = [...new Set(ran.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
      }
    }
    const kept = names.filter((name) => !PRUNE.test(name));
    return { files: kept, count: kept.length, level: kept.length <= 3 ? "quick" : kept.length >= 20 ? "deep" : "standard" };
  });

  action("lp.state_probe", async (_c, rt) => {
    const checkout = await bestEffort(ctx.log, "workflow PM checkout", pmCheckout(rt), null);
    let hasPassport = false, hasUi = false, hasValueMap = false, hasRoadmap = false, hasProfile = false;
    if (checkout) {
      // The planning files of a started project (SMA k_wst_quick): an existing install asks only for what is still missing.
      // With a planning home, the planning part of the probe is asked there; the rest stays in the checkout.
      const research = flagOf(rt, "project.start_research");
      const home = research ? await planHome(rt.projectId, checkout) : null;
      const planningLs = "ls .agents/planning/VALUE-MAP.md .agents/planning/ROADMAP.md .agents/planning/PROFILE.md .agents/planning/profile.json 2>/dev/null";
      const ran = await bestEffort(ctx.log, "workflow state probe", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command: `ls .agents/PASSPORT.md .agents/passport.md PROJECT.md 2>/dev/null | head -1; echo ---; ls package.json src/ui app components 2>/dev/null | head -3${research && !home ? `; echo ---; ${planningLs}` : ""}`, timeoutSec: 20, timeoutMs: 30_000 }), null);
      const homeLs = home ? await bestEffort(ctx.log, "workflow state probe (planning home)", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: home, command: planningLs, timeoutSec: 20, timeoutMs: 30_000 }), null) : null;
      const [passport = "", ui = "", planning = ""] = `${ran?.stdout ?? ""}${home ? `---\n${homeLs?.stdout ?? ""}` : ""}`.split("---");
      const present = new Set(planning.split("\n").map((line) => line.trim().split("/").pop()!.toLowerCase()).filter(Boolean));
      hasPassport = passport.trim().length > 0; hasUi = /app|components|ui/.test(ui);
      hasValueMap = present.has("value-map.md"); hasRoadmap = present.has("roadmap.md");
      // The infra profile lives in the project settings (SMA k_pl_infra): a file from before, or any profile.* key, counts as set.
      const settings = loadProjectSettings(db, rt.projectId);
      hasProfile = present.has("profile.md") || present.has("profile.json") || PROFILE_KEYS.some((key) => String(settings[`profile.${key}`] ?? "").trim() !== "");
    }
    const open = listOpenAttempts(db).filter((row) => row.project_id === rt.projectId).length;
    return { has_passport: hasPassport, open_tasks: open, plan_exists: open > 0, has_ui: hasUi, has_value_map: hasValueMap, has_roadmap: hasRoadmap, has_profile: hasProfile };
  });

  // SMA k_c_backlog: an item into the roadmap's parking lot under the next 999.N number, hash-guarded like the phase's own marks.
  // The file is read with the host's bounded reader (its hash comes with it): absent is the only reason to start a new file; a read
  // that failed, was cut, or does not match its hash stops the action with the reason and writes nothing. (The host's writePhaseBook
  // answers `conflict` and writes nothing when it is given `expectedSha256: null` for a file that exists, so a file wrongly taken as
  // absent could not have been overwritten either; the action now says why instead of reporting a hash conflict.)
  action("lp.roadmap_park", async (c, rt) => {
    const checkout = await pmCheckout(rt);
    const path = ".agents/planning/ROADMAP.md";
    const host = ctx.host as never as { call(m: string, i: unknown, o?: unknown): Promise<Record<string, unknown>> };
    // The planning home moves the roadmap off the checkout (SMA d_project_planning); unset, it is the checkout.
    const root = (await planHome(rt.projectId, checkout)) ?? checkout.path;
    let current = "", expected: string | null = null;
    try {
      const file = await host.call("readBoundedFile", { requestedHostId: checkout.hostId, projectCwd: root, relativePath: path, offset: 0, maxLines: 2000 }, { hostId: checkout.hostId, timeoutMs: 20_000 });
      if (typeof file.content !== "string") throw new Error("the read returned no text");
      if (file.truncated === true) throw new Error("the file is longer than one read");
      if (typeof file.sha256 === "string" && file.sha256 !== sha256Hex(file.content)) throw new Error("the text read does not match the file's hash");
      current = file.content;
      expected = sha256Hex(current);
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      if (!/ENOENT|no such file/i.test(why)) throw new Error(`lp.roadmap_park: ${path} could not be read (${why.slice(0, 300)}): nothing is written`);
    }
    const name = oneLine(str(c.resolve("$inputs.name")), 200);
    if (!name) throw new Error("lp.roadmap_park: the item needs a name");
    const parked = parkRoadmapRow(current, name, str(c.resolve("$inputs.goal")));
    const edits = [{ path, expectedSha256: expected, content: parked.text }];
    const result = await host.call("writePhaseBook", { requestedHostId: checkout.hostId, projectCwd: root, previewSha256: sha256Hex(JSON.stringify(edits)), edits }, { hostId: checkout.hostId, timeoutMs: 30_000 }) as { status: string; reason?: string | null };
    if (result.status !== "applied") throw new Error(`lp.roadmap_park: ${result.reason ?? result.status}`);
    return { ok: true, n: parked.n, path };
  });

  // SMA k_c_import: the pieces an imported plan was cut into stay inside the checkout (the plan gate only asks for some owns_paths).
  action("lp.plan_import_check", async (c) => {
    const problems = list(c.resolve("pieces.pieces")).flatMap((piece) => ownsPathProblems(str(rec(piece).id) || "piece", rec(rec(piece).task).owns_paths));
    return { ok: problems.length === 0, problems: problems.slice(0, 40) };
  });

  // What the start of a project counts from the tree itself, before any question (SMA k_wst_map): five numbers the value map
  // opens VALUE-MAP.md with. Counted on the host (git ls-files, else a find), never by a model. Only where the project set
  // project.start_research to on: unset, nothing is read on the host, `enabled` is off and every note is empty, so the start
  // runs the nodes it always ran with the prompts it always had. The notes (text of the node's params) are the only way the
  // new instructions reach the prompts of the start.
  action("lp.tree_counts", async (c, rt) => {
    const params = rec(rec(c.node).params);
    const none = { enabled: "off", sources: 0, tests: 0, docs: 0, planning: 0, commits: 0, counts_note: "", profile_note: "", recap_note: "" };
    if (!flagOf(rt, "project.start_research")) return none;
    const checkout = await bestEffort(ctx.log, "tree counts checkout", pmCheckout(rt), null);
    if (!checkout) return { ...none, enabled: "on", profile_note: str(params.profile_note), recap_note: str(params.recap_note) };
    const ran = await bestEffort(ctx.log, "tree counts", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path,
      command: "git ls-files 2>/dev/null || find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './dist/*' -not -path './build/*' | sed 's|^\\./||'; echo ===PLAN===; ls .agents/planning 2>/dev/null; echo ===COM===; git rev-list --count HEAD 2>/dev/null || echo 0",
      timeoutSec: 30, timeoutMs: 45_000 }), null);
    const [listing = "", rest = ""] = (ran?.stdout ?? "").split("===PLAN===");
    const [planningHere = "", commitsRaw = ""] = rest.split("===COM===");
    // With a planning home its artifacts are counted there, not in the checkout.
    const home = await planHome(rt.projectId, checkout);
    const planningList = home ? (await bestEffort(ctx.log, "tree counts (planning home)", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: home, command: "ls .agents/planning 2>/dev/null", timeoutSec: 15, timeoutMs: 20_000 }), null))?.stdout ?? "" : planningHere;
    const files = listing.split("\n").map((line) => line.trim()).filter(Boolean);
    const isTest = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z0-9]+$/i, isCode = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt|kts|lua|vue|svelte|c|cc|cpp|h|hpp)$/i;
    const counts = { sources: files.filter((file) => isCode.test(file) && !isTest.test(file)).length,
      tests: files.filter((file) => isTest.test(file)).length,
      docs: files.filter((file) => file.endsWith(".md")).length,
      planning: planningList.split("\n").filter((line) => line.trim()).length,
      commits: parseInt(commitsRaw, 10) || 0 };
    return { enabled: "on", ...counts, counts_note: `${str(params.counts_note)} sources ${counts.sources}, tests ${counts.tests}, docs ${counts.docs}, planning artifacts ${counts.planning}, commits ${counts.commits}.`.trim(),
      profile_note: str(params.profile_note), recap_note: str(params.recap_note) };
  });

  // The post-ship hook files of the project, counted on the host (SMA k_ws_post): the ship starts a session for the hooks only when
  // there is at least one, so a repository without hook files costs no model session. The hooks themselves are listed by `lane-plan render-hooks post-ship`.
  action("lp.post_ship_hooks", async (_c, rt) => {
    const checkout = await bestEffort(ctx.log, "post-ship hooks checkout", pmCheckout(rt), null);
    if (!checkout) return { count: 0, files: [] as string[] };
    const ran = await bestEffort(ctx.log, "post-ship hooks", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: (await planHome(rt.projectId, checkout)) ?? checkout.path, command: "ls .agents/planning/hooks/post-ship*.md 2>/dev/null || true", timeoutSec: 15, timeoutMs: 20_000 }), null);
    const files = (ran?.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    return { count: files.length, files };
  });
}
