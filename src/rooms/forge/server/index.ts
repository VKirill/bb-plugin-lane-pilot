import { z } from "zod";
import { ToolError, registerObservedTool, type ServerCore, type Services } from "../../core/server";
import { hostContract } from "../../contracts";
import { getRun, getRunWriterHost, loadProjectSettings } from "../../storage";
import { isWholeConsent, ownerWordsOn } from "../../tasks";
import { FORGE_KINDS, NAME, creatorBrief, draftFile, draftFolder, enabledPath, lintDraft, sha256, type ForgeKind, type ForgeReceipt } from "../logic";

const RECEIPTS = "lp.forge.receipts";

/**
 * The forge lane (SMA map: Forge lane, Creator, The forge): `draft` sends the Creator — a writer task that owns exactly the one draft
 * folder — `lint` reads the draft and writes the forge receipt, `enable` is two steps on that receipt (request, then confirm with the
 * same bytes; with owner.words on the confirmation carries the owner's whole «да»), and only then the draft lands where its kind lives.
 */
export function mountForge(ctx: ServerCore, services: Services): void {
  const { db, bb } = ctx;
  const host = () => bb.hosts.experimental_client({ contract: hostContract });
  const receipts = async () => ((await bb.storage.kv.get(RECEIPTS).catch(() => null)) as Record<string, ForgeReceipt> | null) ?? {};
  const keyOf = (projectId: string, kind: ForgeKind, name: string) => `${projectId}:${kind}:${name}`;
  const runOf = async (threadId: string, ctxMetadata?: unknown) => {
    // ctx.experimental_vkPluginMetadata carries the same row on VK cores; the SDK read is the upstream fallback.
    const metadata = (ctxMetadata !== undefined ? ctxMetadata : await bb.sdk.threads.getPluginMetadata({ threadId })) as Record<string, unknown> | null;
    const runId = typeof metadata?.lanePilotRunId === "string" ? metadata.lanePilotRunId : null;
    if (metadata?.role !== "pm" || !runId) throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
    const run = getRun(db, runId);
    const hostId = getRunWriterHost(db, runId);
    if (!run?.writer_workspace_path || !hostId) throw new ToolError("this run has no checkout", { code: "no_checkout", retryable: false, sideEffects: "none" });
    return { runId, cwd: run.writer_workspace_path, hostId };
  };
  const read = async (threadId: string, projectId: string, path: string) => {
    try { return (await services.readWriterWorkspaceFile({ threadId, projectId, path, offset: 0, maxLines: 2000 }) as { content?: string }).content ?? ""; }
    catch { return ""; }
  };
  const refuse = (message: string, code: string) => new ToolError(message, { code, retryable: false, sideEffects: "none" });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_forge",
    description: "The forge: have the Creator write exactly one new skill, role or workflow draft, lint it into a receipt, and enable it in two steps.",
    instructions: "`draft` (kind skill|role|workflow, name kebab-case, brief: what it is for and when to use it) sends the Creator — a writer task that owns only .agents/forge/<kind>s/<name>/ and writes the one draft file. When it is accepted, `lint` (kind, name) reads the draft: findings, or a receipt with its hash. `enable` step request, then step confirm (with owner.words on, ownerSaid = the owner's whole answer, after you asked him) puts the same bytes where the kind lives: .claude/skills/<name>/SKILL.md, .claude/agents/<name>.md or .lane-pilot/workflows/<name>.json. A changed draft needs a new lint. Never forbidden grants: permission bypass, every tool, destructive shell, secrets, the guard or hooks.",
    parameters: z.discriminatedUnion("action", [
      z.object({ action: z.literal("draft"), kind: z.enum(FORGE_KINDS), name: z.string().regex(NAME), brief: z.string().trim().min(20).max(4000) }).strict(),
      z.object({ action: z.literal("lint"), kind: z.enum(FORGE_KINDS), name: z.string().regex(NAME) }).strict(),
      z.object({ action: z.literal("enable"), kind: z.enum(FORGE_KINDS), name: z.string().regex(NAME), step: z.enum(["request", "confirm"]), ownerSaid: z.string().max(600).optional() }).strict(),
      z.object({ action: z.literal("list") }).strict(),
    ]),
    execute: async (input, context) => {
      if (input.action === "list") return JSON.stringify(Object.entries(await receipts()).filter(([key]) => key.startsWith(`${context.projectId}:`)).map(([, row]) => row));
      const run = await runOf(context.threadId, (context as { experimental_vkPluginMetadata?: unknown }).experimental_vkPluginMetadata);
      const all = await receipts();
      const key = keyOf(context.projectId, input.kind, input.name);
      if (input.action === "draft") {
        // Exactly one draft: the Creator owns the one folder and writes the one file; the check is the forge lint itself.
        const file = draftFile(input.kind, input.name);
        const id = `forge-${input.kind}-${input.name}`;
        const reply: Record<string, unknown> = await services.dispatchWriter({ threadId: context.threadId, projectId: context.projectId, birth: "pm",
          task: { schema_version: 2, id, title: `Forge ${input.kind} ${input.name}`, display_title: `Черновик: ${input.name}`.slice(0, 60), kind: "docs", area: `forge:${input.name}`,
            risk: "low", lane: "default", project_cwd: run.cwd, read_first: [], interfaces: [], invariants: ["no forbidden grant"], out_of_scope: ["any file outside the draft folder"],
            expected_outputs: [file], owns_paths: [`${draftFolder(input.kind, input.name)}/`], never_touch: [".claude/", ".lane-pilot/"], depends_on: [],
            objective: creatorBrief(input.kind, input.name, input.brief), acceptance: [`${file} passes lane-forge-lint`], verify: "smoke",
            verification: [{ command: `lane-forge-lint ${input.kind} ${input.name} ${file}`, cwd: run.cwd, timeout_sec: 60 }] } as never,
          plan: `The forge: the Creator writes one ${input.kind} draft.`, objective: input.brief });
        return JSON.stringify({ ...reply, draft: file, next: "when the task is accepted: lane_pilot_forge lint" });
      }
      const path = draftFile(input.kind, input.name);
      const text = await read(context.threadId, context.projectId, path);
      if (input.action === "lint") {
        const findings = lintDraft(input.kind, input.name, text);
        // The forge receipt: the bytes that passed (or failed) the lint; enabling checks the same bytes are still there.
        const receipt: ForgeReceipt = { kind: input.kind, name: input.name, path, sha256: sha256(text), ok: findings.length === 0, findings, at: Date.now() };
        all[key] = receipt;
        await bb.storage.kv.set(RECEIPTS, all as never);
        return JSON.stringify(receipt);
      }
      const receipt = all[key];
      if (!receipt) throw refuse(`no forge receipt for ${input.kind} ${input.name}: lint it first`, "no_receipt");
      if (!receipt.ok) throw refuse(`the draft failed the lint: ${receipt.findings.map((row) => row.message).join("; ")} — fix it (lane_pilot_update_task on the forge task) and lint again`, "lint_failed");
      if (sha256(text) !== receipt.sha256) throw refuse("the draft changed since its receipt: lint it again", "changed");
      if (input.step === "request") {
        all[key] = { ...receipt, requestedAt: Date.now() };
        await bb.storage.kv.set(RECEIPTS, all as never);
        return JSON.stringify({ requested: true, next: "step confirm puts it in place" });
      }
      if (!receipt.requestedAt) throw refuse("enabling is two steps: request first, then confirm", "no_request");
      const ownerWords = ownerWordsOn(loadProjectSettings(db, context.projectId));
      if (ownerWords && !(input.ownerSaid && isWholeConsent(input.ownerSaid))) throw refuse("owner.words is on: ask the owner (lane_pilot_ask_owner) and pass his whole «да» as ownerSaid", "owner_word");
      const target = enabledPath(input.kind, input.name);
      if (input.kind === "workflow") {
        const written = await host().call("writeWorkflowFile", { requestedHostId: run.hostId, projectCwd: run.cwd, id: input.name, content: text, expectedSha256: null }, { hostId: run.hostId, timeoutMs: 30_000 });
        if (written.status !== "applied") throw refuse(`the workflow was not written: ${written.reason ?? written.status}`, "not_written");
      } else {
        const edits = [{ path: target, expectedSha256: null, content: text }];
        const written = await host().call("writeForgeEnabled", { requestedHostId: run.hostId, projectCwd: run.cwd, previewSha256: sha256(JSON.stringify(edits)), edits }, { hostId: run.hostId, timeoutMs: 30_000 });
        if (written.status !== "applied") throw refuse(`the draft was not enabled: ${written.reason ?? written.status}`, "not_written");
      }
      all[key] = { ...receipt, enabledAt: Date.now(), enabledBy: ownerWords ? "owner" : "pm" };
      await bb.storage.kv.set(RECEIPTS, all as never);
      return JSON.stringify({ enabled: target, sha256: receipt.sha256 });
    },
  });
}
