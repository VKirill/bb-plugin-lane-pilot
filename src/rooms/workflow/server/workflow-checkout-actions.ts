import { noteEngineWrite } from "../../verification/server";
import {
  getRun,
  getRunWriterHost,
  inferArtifactMetaFromRelPath,
  listOpenAttempts,
  loadProjectSettings,
  renderArtifactsManifestJson,
  upsertProjectArtifact,
  writeCasCheckoutFile,
} from "../../storage";
import { isPlanningPath } from "../../contracts";
import { PROFILE_KEYS } from "../../anamnesis";
import { hasPassportRecord } from "../../passport";
import { bestEffort, isFsAbsent, sha256Hex } from "@lane-pilot/kit";
import { list, rec, str, pmCheckout, quote, PRUNE } from "./workflow-chain-runtime";
import { CAS_READ_CAP_BYTES, isMissingCasFile } from "./workflow-file-cas";
import { measureTestInventory, diffTestInventory, type InventoryReceipt } from "./test-inventory";
import { noteRunFiles } from "./workflow-run-home";
import type { Row } from "./workflow-chain-runtime";
import { wfInventoryRows, wfInventoryBaselineSucceeded, wfClaimInventoryBaseline, type InventoryStep, type GraphNode, type StepContext, type WorkflowEngine } from "@lane-pilot/workflow-engine";
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

  // Receipts live in the engine journal: the action output is persisted with the engine's output hash before routing.
  const inventory = (mode: "baseline" | "after") => async (c: StepContext<ChainRuntime>, rt: ChainRuntime): Promise<Row> => {
    const unavailable = (reason: string): Row => ({ status: "unavailable", reason });
    try {
      if (!rt.runId) return unavailable("no bound Lane Pilot run");
      const run = getRun(db, rt.runId), checkout = await pmCheckout(rt), hostId = getRunWriterHost(db, rt.runId);
      if (!run || run.project_id !== rt.projectId || !hostId || !run.writer_workspace_path || checkout.hostId !== hostId || checkout.path !== run.writer_workspace_path) return unavailable("writer checkout binding mismatch");
      const rows = wfInventoryRows(db, c.runId);
      const decode = (row: InventoryStep, executor: string): Row => {
        const receipt = JSON.parse(row.receipt_json), output = JSON.parse(row.output_json);
        if (receipt.executor !== executor || receipt.outputSha256 !== sha256Hex(row.output_json) || !output || typeof output !== "object") throw Error("untrusted journal receipt");
        return output as Row;
      };
      const baselines = rows.filter(r => r.node_id === "baseline");
      if (mode === "baseline") {
        // rerunNode removes descendant steps and clears their outputs, but the append-only event journal survives.
        const previous = wfInventoryBaselineSucceeded(db, c.runId);
        if (previous || baselines.length || rows.some(r => r.node_id === "write_tests")) return unavailable("original baseline already exists or was invalidated by rerun");
        const claimed = wfClaimInventoryBaseline(db, engine.journal, c.runId, c.workflow.id, c.stepKey);
        if (!claimed) return unavailable("original baseline already exists or was invalidated by rerun");
        const result = await measureTestInventory(ctx.host, hostId, checkout.path);
        return result.status === "measured" ? { status: "measured", reason: "", receipt: result.receipt } : { status: result.status, reason: result.reason };
      }
      const writers = rows.filter(r => r.node_id === "write_tests"), fixes = rows.filter(r => r.node_id === "fix_tests");
      if (baselines.length !== 1 || writers.length !== 1 || baselines[0]!.rowid >= writers[0]!.rowid) return unavailable("original baseline or writer result missing");
      const base = decode(baselines[0]!, "lp.test_inventory_baseline"), writer = decode(writers[0]!, "lp-task");
      if (base.status !== "measured" || writer.state !== "accepted" || !base.receipt || !Array.isArray(writer.files) || !writer.files.every(x => typeof x === "string")) return unavailable("baseline or writer acceptance unavailable");
      let merge = str(writer.merge_commit);
      if (fixes.length) {
        const fix = decode(fixes[fixes.length - 1]!, "lp-task");
        if (fix.state !== "accepted") return unavailable("latest fix was not accepted");
        merge = str(fix.merge_commit);
      }
      const result = await measureTestInventory(ctx.host, hostId, checkout.path);
      if (result.status !== "measured") return { status: result.status, reason: result.reason };
      const diff = await diffTestInventory(ctx.host, base.receipt as InventoryReceipt, result.receipt, merge, writer.files as string[]);
      return diff.status === "measured" ? { status: "measured", reason: result.receipt.exit === 0 ? "" : "node test runner reported failures", runner_ok: result.receipt.exit === 0, tests_added: diff.testsAdded, receipt: result.receipt } : { status: "unavailable", reason: diff.reason, receipt: result.receipt };
    } catch (e) { return unavailable(e instanceof Error ? e.message : String(e)); }
  };
  action("lp.test_inventory_baseline", inventory("baseline"));
  action("lp.test_inventory_after", inventory("after"));

  action("fs.write", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = node.params as Row;
    const checkout = await pmCheckout(rt);
    const rel = c.render(str(params.path)).replace(/^\/+/, "");
    const interiorEmpty = rel.replace(/\/+$/, "").split("/").includes("");
    if (!rel || rel.split("/").includes("..") || rel.includes("\0") || interiorEmpty) throw new Error(`fs.write: the path "${rel}" is not inside the checkout`);
    const rawKind = str(params.kind ?? rec(c.node).kind).trim().toLowerCase();
    const isFolder = rawKind === "folder" || rawKind === "dir" || rawKind === "directory" || rel.endsWith("/");
    const folderPrefix = isFolder ? (rel.endsWith("/") ? rel : `${rel}/`) : "";
    // A planning file (.agents/phases|planning|todos|plans, not a task's own folder) goes to the planning home when the project set one (SMA d_project_planning); unset, the checkout.
    const home = isPlanningPath(isFolder ? folderPrefix : rel) ? await planHome(rt.projectId, checkout) : null;
    const mode = str(params.mode).trim().toLowerCase();
    const ifExists = params.if_exists === true || String(params.if_exists ?? "") === "true";
    if (mode && mode !== "append" && mode !== "prepend" && mode !== "non_overwrite") throw new Error(`fs.write: unsupported mode "${mode}"`);
    if ((mode === "append" || mode === "prepend") && isFolder) throw new Error("fs.write: append/prepend mode requires a single file path");
    if (mode === "non_overwrite" && isFolder) throw new Error("fs.write: non_overwrite mode requires a single file path");
    if (ifExists && !mode) throw new Error("fs.write: if_exists requires a mode (append, prepend or non_overwrite)");
    const writtenCheckoutPaths: Array<{ path: string; content: string; sha256: string }> = [];
    // Every file this node wrote, for the run's manifest (.agents/runs/<run>/manifest.json): the checkout's and the planning home's alike.
    const writtenForRun: Array<{ repoPath: string; content: string; kind: "output"; root: "checkout" | "planning-home" }> = [];
    let writtenFileCount = 0;
    let ifExistsSkipped = false;
    /** The `<name>.new.<ext>` sibling a non_overwrite write lands in when the file is already there (SMA k_pl_researchdir). */
    const newSiblingPath = (cleanPath: string): string => {
      const slash = cleanPath.lastIndexOf("/"), dir = slash < 0 ? "" : `${cleanPath.slice(0, slash + 1)}`, base = cleanPath.slice(slash + 1);
      const dot = base.lastIndexOf(".");
      return dot <= 0 ? `${dir}${base}.new.md` : `${dir}${base.slice(0, dot)}.new${base.slice(dot)}`;
    };
    const write = async (path: string, content: string): Promise<string | null> => {
      const cleanPath = path.replace(/^\/+/, "");
      if (!cleanPath || cleanPath.endsWith("/") || cleanPath.split("/").includes("..") || cleanPath.includes("\0") || cleanPath.replace(/\/+$/, "").split("/").includes("")) {
        throw new Error(`fs.write: invalid target file path "${cleanPath}"`);
      }
      if (mode) {
        const files = bb.sdk.files as unknown as {
          read?: (args: { hostId: string; rootPath: string; path: string }) => Promise<unknown>;
          write: (args: { hostId: string; rootPath: string; path: string; content: string; contentEncoding: "utf8"; createParents: boolean; expectedSha256: string | null }) => Promise<unknown>;
        };
        if (typeof files.read !== "function") throw new Error(`fs.write: cannot ${mode} "${cleanPath}" because the existing file is unreadable`);
        const rootPath = home ?? checkout.path;
        const casRead = async (relPath: string): Promise<{ content: string; sha256: string } | null> => {
          const raw = await files.read!({ hostId: checkout.hostId, rootPath, path: `${rootPath}/${relPath}` });
          if (raw === null || raw === undefined) throw new Error("the existing file read returned no result");
          if (typeof raw !== "object") throw new Error("the existing file read returned an invalid result");
          const existing = raw as { content?: unknown; sha256?: unknown; sizeBytes?: unknown };
          if (typeof existing.content !== "string") throw new Error("the existing file read returned no text");
          if (typeof existing.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(existing.sha256)) throw new Error("the existing file read returned an invalid hash");
          const sizeBytes = existing.sizeBytes;
          const actualSize = Buffer.byteLength(existing.content, "utf8");
          if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes !== actualSize) throw new Error("the existing file read returned an invalid size");
          if (sizeBytes > CAS_READ_CAP_BYTES) throw new Error(`the existing file exceeds the ${CAS_READ_CAP_BYTES}-byte read limit`);
          if (existing.sha256.toLowerCase() !== sha256Hex(existing.content)) throw new Error("the existing file read does not match its hash");
          return { content: existing.content, sha256: existing.sha256 };
        };
        // Never-overwrite (SMA k_pl_researchdir): an existing file is left byte for byte and the new text lands in <name>.new.<ext>;
        // an occupied sibling refuses instead of clobbering either. Both writes are create-only (expectedSha256 null).
        if (mode === "non_overwrite") {
          let target = cleanPath;
          try {
            await casRead(target);
            target = newSiblingPath(target);
            try { await casRead(target); throw new Error(`fs.write: "${target}" already exists — neither the file nor its .new sibling is touched`); }
            catch (cause) { if (!isMissingCasFile(cause)) throw cause; }
          } catch (cause) {
            if (!isMissingCasFile(cause)) {
              const why = cause instanceof Error ? cause.message : String(cause);
              throw new Error(`cannot ${mode} "${cleanPath}": ${why}`);
            }
          }
          const fullTarget = `${rootPath}/${target}`;
          const result = await files.write({ hostId: checkout.hostId, rootPath, path: fullTarget, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
          const outcome = result && typeof result === "object" ? String((result as { outcome?: unknown }).outcome ?? "") : "";
          if (outcome !== "written") throw new Error(`fs.write: CAS write rejected for "${target}" (${outcome || "unknown"})`);
          writtenFileCount += 1;
          writtenForRun.push({ repoPath: target, content, kind: "output", root: home ? "planning-home" : "checkout" });
          if (!home) { writtenCheckoutPaths.push({ path: target, content, sha256: sha256Hex(content) }); noteEngineWrite(checkout.path, target); }
          return target;
        }
        const fullPath = `${rootPath}/${cleanPath}`;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let previous = "", expectedSha256: string | null = null;
          try {
            const existing = await casRead(cleanPath);
            previous = existing!.content;
            expectedSha256 = existing!.sha256;
          } catch (cause) {
            if (!isMissingCasFile(cause)) {
              const why = cause instanceof Error ? cause.message : String(cause);
              throw new Error(`cannot ${mode} "${cleanPath}": ${why}`);
            }
            // append/prepend with if_exists: a missing file is a skip, never a create (SMA k_pl_project — PROJECT.md is only ever appended to).
            if (ifExists) { ifExistsSkipped = true; return null; }
            previous = "";
            expectedSha256 = null;
          }
          const next = mode === "prepend" ? `${content}${previous}` : `${previous}${content}`;
          const result = await files.write({ hostId: checkout.hostId, rootPath, path: fullPath, content: next, contentEncoding: "utf8", createParents: true, expectedSha256 });
          const outcome = result && typeof result === "object" ? String((result as { outcome?: unknown }).outcome ?? "") : "";
          if (outcome === "written") {
            writtenFileCount += 1;
            writtenForRun.push({ repoPath: cleanPath, content: next, kind: "output", root: home ? "planning-home" : "checkout" });
            if (!home) writtenCheckoutPaths.push({ path: cleanPath, content: next, sha256: sha256Hex(next) });
            if (!home) noteEngineWrite(checkout.path, cleanPath);
            return cleanPath;
          }
          if (outcome === "conflict" && attempt === 0) continue;
          throw new Error(`fs.write: CAS write rejected for "${cleanPath}" (${outcome || "unknown"})`);
        }
        throw new Error(`fs.write: CAS write rejected for "${cleanPath}" (conflict)`);
      }
      if (home) {
        const homeRes = await writeCasCheckoutFile(bb.sdk.files as never, {
          hostId: checkout.hostId,
          rootPath: home,
          relPath: cleanPath,
          content,
        });
        if (!homeRes.ok) {
          throw new Error(`fs.write: CAS write rejected for "${cleanPath}" (${homeRes.outcome})`);
        }
        writtenFileCount += 1;
        writtenForRun.push({ repoPath: cleanPath, content, kind: "output", root: "planning-home" });
        return cleanPath;
      }
      // Noted before the write lands, so a helper's status read right after it already sees it as the engine's.
      noteEngineWrite(checkout.path, cleanPath);
      const casRes = await writeCasCheckoutFile(bb.sdk.files as never, {
        hostId: checkout.hostId,
        rootPath: checkout.path,
        relPath: cleanPath,
        content,
      });
      if (!casRes.ok) {
        throw new Error(`fs.write: CAS write rejected for "${cleanPath}" (${casRes.outcome})`);
      }
      writtenFileCount += 1;
      writtenCheckoutPaths.push({ path: cleanPath, content, sha256: casRes.sha256 });
      writtenForRun.push({ repoPath: cleanPath, content, kind: "output", root: "checkout" });
      return cleanPath;
    };
    const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
    const resolveTargetPath = (entryName: string): string => {
      const cleanEntry = entryName.replace(/^\/+/, "");
      if (!isFolder) return rel;
      if (!cleanEntry) throw new Error(`fs.write: empty file entry inside folder "${folderPrefix}"`);
      return cleanEntry.startsWith(folderPrefix) ? cleanEntry : `${folderPrefix}${cleanEntry}`;
    };
    let first = isFolder ? folderPrefix : rel;
    let wroteHandoff = false;
    if (params.contents && typeof params.contents === "object" && !Array.isArray(params.contents)) {
      for (const [name, template] of Object.entries(params.contents as Row)) {
        const value = c.template(template);
        const target = resolveTargetPath(name);
        const landed = await write(target, asText(value ?? ""));
        if (target.endsWith("/handoff.md") || target === "handoff.md") wroteHandoff = true;
        first = first === (isFolder ? folderPrefix : rel) ? (landed ?? target) : first;
      }
    } else if (params.files !== undefined && params.files !== null) {
      const resolvedFiles = c.template(params.files);
      if (Array.isArray(resolvedFiles)) {
        for (const item of resolvedFiles) {
          if (typeof item === "string" && item.trim()) {
            const name = item.trim();
            const base = name.split("/").pop() ?? name;
            const stem = base.replace(/\.[^.]+$/, "");
            const candidate =
              params[name] ??
              params[base] ??
              params[stem] ??
              (c.inputs as Row | undefined)?.[name] ??
              (c.inputs as Row | undefined)?.[stem] ??
              reportBody(c, params);
            const target = resolveTargetPath(name);
            const landed = await write(target, asText(candidate ?? ""));
            if (target.endsWith("/handoff.md") || target === "handoff.md") wroteHandoff = true;
            first = first === (isFolder ? folderPrefix : rel) ? (landed ?? target) : first;
          } else if (item && typeof item === "object") {
            const recItem = item as Row;
            const rawName = String(recItem.path ?? recItem.name ?? recItem.file ?? "").trim();
            if (!rawName) continue;
            const body = recItem.content ?? recItem.body ?? recItem.text ?? recItem.value ?? reportBody(c, params);
            const target = resolveTargetPath(rawName);
            const landed = await write(target, asText(body ?? ""));
            if (target.endsWith("/handoff.md") || target === "handoff.md") wroteHandoff = true;
            first = first === (isFolder ? folderPrefix : rel) ? (landed ?? target) : first;
          }
        }
      } else if (typeof resolvedFiles === "object") {
        for (const [name, body] of Object.entries(resolvedFiles as Row)) {
          const target = resolveTargetPath(name);
          const landed = await write(target, asText(body ?? ""));
          if (target.endsWith("/handoff.md") || target === "handoff.md") wroteHandoff = true;
          first = first === (isFolder ? folderPrefix : rel) ? (landed ?? target) : first;
        }
      }
    } else if (!isFolder) {
      if (typeof params.contents === "string") {
        const landed = await write(rel, asText(c.template(params.contents)));
        first = landed ?? "";
        return await finishWrite();
      }
      const landedSingle = await write(rel, asText(reportBody(c, params)));
      first = landedSingle ?? (first === rel ? "" : first);
    }
    if (
      isFolder &&
      !wroteHandoff &&
      (writtenFileCount === 0 || c.node.out.some((f) => f.name === "handoff_path")) &&
      c.node.out.some((f) => f.name === "handoff_path" || f.name.endsWith("_path"))
    ) {
      const handoffTarget = `${folderPrefix}handoff.md`;
      const landed = await write(handoffTarget, asText(reportBody(c, params)));
      first = first === folderPrefix ? (landed ?? handoffTarget) : first;
    }
    return await finishWrite();

    async function finishWrite(): Promise<Row> {
    if (!home && rt?.projectId && writtenCheckoutPaths.length > 0) {
      let touchedAgentsArtifact = false;
      for (const item of writtenCheckoutPaths) {
        if (!item.path.startsWith(".agents/") || item.path === ".agents/manifest.json") continue;
        const meta = inferArtifactMetaFromRelPath(item.path);
        if (!meta) continue;
        upsertProjectArtifact(db, {
          projectId: rt.projectId,
          artifactId: meta.artifactId,
          domain: meta.domain,
          kind: meta.kind,
          relPath: item.path,
          sha256: item.sha256,
          summary: `${meta.domain}/${meta.kind} (${item.path})`,
          producerWf: c.workflow.id,
          producerRunId: c.runId,
        });
        touchedAgentsArtifact = true;
      }
      if (touchedAgentsArtifact) {
        const manifestJson = renderArtifactsManifestJson(db, rt.projectId);
        noteEngineWrite(checkout.path, ".agents/manifest.json");
        const manifestRes = await writeCasCheckoutFile(bb.sdk.files as never, {
          hostId: checkout.hostId,
          rootPath: checkout.path,
          relPath: ".agents/manifest.json",
          content: manifestJson,
        });
        if (!manifestRes.ok) {
          throw new Error(`fs.write conflict on ".agents/manifest.json" (${manifestRes.outcome})`);
        }
      }
    }
    // Declared readers: the nodes this one's edges lead to (the real reads are recorded by the readers as `read_by`).
    const successors = [...new Set(c.workflow.edges.filter((edge) => edge.from === c.nodeId).map((edge) => edge.to))];
    await noteRunFiles(ctx, rt, c, checkout, writtenForRun.map((file) => ({ ...file, readers: successors })));
    const out: Row = {};
    for (const field of c.node.out) {
      if (field.name === "folder") out.folder = isFolder ? folderPrefix : rel.slice(0, rel.lastIndexOf("/") + 1) || "./";
      else if (field.name === "handoff_path") out.handoff_path = isFolder ? `${folderPrefix}handoff.md` : rel;
      else if (field.name.endsWith("_path")) out[field.name] = writtenFileCount === 0 && ifExistsSkipped ? "" : isFolder ? (writtenFileCount === 1 ? first : folderPrefix) : first;
    }
    return out;
    }
  });

  /** A file the chain writes: JSON of what it `reads`, else a Markdown report of the run so far. */
  function reportBody(c: StepContext<ChainRuntime>, params: Row): unknown {
    const reads = list(rec(c.node).reads).map(String);
    if (reads.length) return Object.fromEntries(reads.map((ref) => [ref.split(".").pop()!, c.resolve(ref)]));
    const rows = c.workflow.nodes.filter((node) => node.type !== "note" && node.id !== c.nodeId).map((node) => [node.id, c.resolve(node.id)] as const).filter(([, value]) => value !== undefined && Object.keys(rec(value)).length);
    return [`# ${c.workflow.name.en}`, "", str(params.template) ? `Contents: ${str(params.template)}.` : "", ...rows.flatMap(([id, value]) => ["", `## ${id}`, "```json", JSON.stringify(value, null, 1), "```"])].join("\n");
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
      const ran = await bestEffort(ctx.log, "workflow state probe", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: checkout.path, command: `ls .agents/passport/PASSPORT.md .agents/PASSPORT.md .agents/passport.md PROJECT.md 2>/dev/null | head -1; echo ---; ls package.json src/ui app components 2>/dev/null | head -3${research && !home ? `; echo ---; ${planningLs}` : ""}`, timeoutSec: 20, timeoutMs: 30_000 }), null);
      const homeLs = home ? await bestEffort(ctx.log, "workflow state probe (planning home)", runOnHost(ctx.host, { hostId: checkout.hostId, cwd: home, command: planningLs, timeoutSec: 20, timeoutMs: 30_000 }), null) : null;
      const [passport = "", ui = "", planning = ""] = `${ran?.stdout ?? ""}${home ? `---\n${homeLs?.stdout ?? ""}` : ""}`.split("---");
      const present = new Set(planning.split("\n").map((line) => line.trim().split("/").pop()!.toLowerCase()).filter(Boolean));
      hasPassport = passport.trim().length > 0; hasUi = /app|components|ui/.test(ui);
      hasValueMap = present.has("value-map.md"); hasRoadmap = present.has("roadmap.md");
      // The infra profile lives in the project settings (SMA k_pl_infra): a file from before, or any profile.* key, counts as set.
      const settings = loadProjectSettings(db, rt.projectId);
      hasProfile = present.has("profile.md") || present.has("profile.json") || PROFILE_KEYS.some((key) => String(settings[`profile.${key}`] ?? "").trim() !== "");
    }
    if (!hasPassport && rt.projectId) hasPassport = hasPassportRecord(db, rt.projectId);
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
