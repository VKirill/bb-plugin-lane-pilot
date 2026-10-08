import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import { openAllTabs } from "./ui-tabs";

// Shared harness of the settings-page UI tests: the fixture screen, the RPC defaults and a mounted page with every tab warmed.
// The test files keep their own vi.mock("sonner") and configure() calls.

export function screenFixture() {
  const values = Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, row.defaultValue]));
  values["writer.provider"] = "codex";
  values["writer.model"] = "test-model";
  values["writer.reasoning_effort"] = "medium";
  return {
    projectId: "proj_ui",
    hostId: "host_ui",
    workspacePath: "/tmp/lane-pilot-ui",
    explicitKeys: ["writer.provider", "writer.model", "writer.reasoning_effort"],
    values,
    versions: Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, 1])),
    importSource: { completed: true, at: 1, routingPath: "/tmp/routing.profile.yaml", nightPath: "/tmp/night-shift.yaml" },
    runs: [{
      id: "lprun_1",
      state: "running",
      kind: "bb",
      created_at: 1,
      updated_at: 1,
      cliReceiptJson: null,
      stageCount: 1,
      attempts: [{
        id: "lpattempt_1",
        state: "running",
        attempt_no: 1,
        thread_id: "thr_writer",
        reason: null,
        task_id: "task_1",
        cliReceiptJson: null,
      }],
    }],
    unapplied: [{ key: "plan_critique.mode", reason: "no proven runtime channel" }],
    cliPreview: { argv:["run", "--provider", "codex", "--service-tier", "fast"], env:{}, applied:["writer.provider"], unapplied:[] },
    legacyStack: true,
    lastSnapshotPath: "/tmp/snapshot",
    lastReceiptJson: "{\"action\":\"install\"}",
    writerResultJson: "{\"status\":\"accepted\",\"output\":\"hello from writer\"}",
    writerResultPatch: "--- /dev/null\n+++ b/writer-output.txt\n@@ -0,0 +1,1 @@\n+hello from writer\n",
    cliReceiptJson: null,
    qaHosts: [
      { id:"host_ui", name:"Writer", status:"connected", connected:true },
      { id:"host-qa-mini", name:"Mini", status:"connected", connected:true },
    ],
    lastWriterTrace: null,
  };
}

// Maintenance shows the Lane Stack install only after a check finds it missing.
export const missingStack = () => ({
  hostId:"host_ui", laneStack:{ present:false, version:null, sourceSha:null },
  openCode:{ present:true, version:"1.18.30" }, workspace:{ path:"/tmp/lane-pilot-ui", present:true },
  targetSha:"abc123", matchesTarget:false, scenario:"S3",
});

export async function mountPage(
  rpc: Record<string, (input: unknown) => unknown> = {},
  context: { projectId: string | null; threadId: string | null } = { projectId:"proj_ui", threadId:null },
  subPath = "",
  warm = true,
) {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, {
    context,
    providers:{ status:"ready", providers:[{
      id:"codex", displayName:"Codex", available:true,
      capabilities:{ modelCatalogScope:"host", permissionModes:[], supportsFork:false, supportsNativeUserQuestion:false,
        supportsServiceTier:true, supportsSessionRewind:false, supportsThreadArchive:false, supportsThreadRename:false },
      serviceTiers:[{ id:"default", label:"Default" }, { id:"fast", label:"Fast" }],
    }] as never },
    rpc: {
      get_preferences: (input: unknown) => ({ locale: (input as {suggestedLocale:"en"|"ru"}).suggestedLocale, preference:"auto", lastProjectId: null }),
      set_locale: (input: unknown) => ({ locale: (input as {locale:"auto"|"en"|"ru"; suggestedLocale:"en"|"ru"}).locale === "auto" ? (input as {suggestedLocale:"en"|"ru"}).suggestedLocale : (input as {locale:"en"|"ru"}).locale, preference: (input as {locale:"auto"|"en"|"ru"}).locale }),
      remember_project: () => ({ ok:true }),
      list_projects: () => ({ projects:[{ id:"proj_ui", name:"UI test" }], lastProjectId:"proj_ui" }),
      finish_run: () => ({ projectId:"proj_ui", finishedRunIds:[], closed:true }),
      get_screen: () => screenFixture(),
      list_run_stages: () => ({ stages: [{
        contractVersion:1, runId:"lprun_1", taskId:"task_1", stageId:"plan-critique", state:"passed",
        inputSha256:"a".repeat(64), outputSha256:"b".repeat(64), attempt:1,
        providerId:"codex", model:"test-model", threadId:"thr_critic",
        hasResult:true, reason:null, updatedAt:1,
      }] }),
      get_stage_result: () => ({ found:true, result:{ decision:"approve", summary:"Plan checked", findings:[] } }),
      get_globals: () => ({ defaults: {}, revision: 0, agents: [] }),
      save_setting: () => ({ ok: true, conflict: false, version: 2, value: true }),
      save_settings: () => ({ ok:true, conflict:false, values:{}, versions:{} }),
      cancel_attempt: () => ({ ok: true, state: "canceled", reason: null }),
      retry_attempt: () => ({ ok: true, state: "queued", attemptId: "lpattempt_2", reason: null }),
      resume_runs: () => ({ resumed: [], skipped: [], finished: [] }),
      stack_detect: () => ({
        hostId:"host_ui", laneStack:{ present:true, version:"1.38.0", sourceSha:"abc123" },
        openCode:{ present:true, version:"1.18.30" }, workspace:{ path:"/tmp/lane-pilot-ui", present:true },
        targetSha:"abc123", matchesTarget:true, scenario:"S1",
      }),
      stack_install: () => ({ status: "ok" }),
      stack_connect: () => ({ status: "ok" }),
      stack_rollback: () => ({ status: "ok" }),
      ...rpc,
    },
  });
  // Tabs mount when first opened and most tests read several of them: open each once (as an owner browsing would) and come back.
  if (warm && context.projectId) await openAllTabs(slot);
  return slot;
}
