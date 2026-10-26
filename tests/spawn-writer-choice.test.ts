import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import "../server";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase } from "../src/rooms/storage/database";
import { createWriterSpawn } from "../src/rooms/writer/server/spawn";

const config: PrototypeConfig = {
  projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
  pmProviderId:"codex", pmModel:"codex-test", writerProviderId:"acp-cursor", writerModel:"composer-2.5",
};
const task: TaskV2 = {
  schema_version:2, id:"t1", title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[],
  objective:"write", acceptance:["file exists"], verify:"none", verification:[],
};

// Vampirism Fire 2026-10-25/26: Jev picked gemini-flash, sonnet, sonnet, haiku for four tasks and every one ran as composer-2.5 — the
// start's choice never reached the spawn, which read the stored settings again. The breaker is asked about the writer the spawn chose.
async function chosenWriter(writerSettings?: Record<string, unknown>) {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task });
  createAttempt(db, { id:"a1", runId:"run", taskId:"t1" });
  const asked: string[] = [];
  const ctx = {
    bb:{ storage:bb.storage, log:{ info() {}, warn() {} }, sdk:{ projects:{ get:async () => ({ sources:[] }) }, files:{ read:async () => ({ content:null }) },
      threads:{ get:async () => ({ id:"pm", projectId:"P", status:"idle" }), stop:async () => ({}), spawn:async () => ({ id:"writer-1" }) } } },
    db,
    host:{ call:async (method:string) => method === "runCommand" ? { hostId:"h", exitCode:0, stdout:"[]", stderr:"" } : {} },
    effectiveProjectSettings:async () => ({ values:{ "writer.provider":"acp-cursor", "writer.model":"composer-2.5", "memory.enabled":false, "adoc.040":"auto" } }),
  };
  const services = { providerBreaker:{ decide:(key: string) => { asked.push(key); return { allow:false, reason:"stop here" }; } }, ruleScan:{ chainForRun:async () => [] } };
  const writer = createWriterSpawn(ctx as never, services as never);
  await writer.spawnWriterAttempt({ projectId:"P", runId:"run", taskId:"t1", attemptId:"a1", config, task, plan:"write", pmThreadId:"pm", ...(writerSettings ? { writerSettings } : {}) });
  return asked;
}

it("the spawn starts the writer the start chose, not the project's stored writer", async () => {
  expect((await chosenWriter({ "writer.provider":"claude-code", "writer.model":"claude-haiku-5-5" })).join("|")).toMatch(/claude-haiku-5-5/);
  expect((await chosenWriter()).join("|")).toMatch(/composer-2\.5/);
});
