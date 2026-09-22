import { writeFileSync, mkdirSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createRun, getAttempt, listAttemptsForTask, openDatabase, savePrototypeConfig, setRunThread } from "../src/database";
import type { TaskV2 } from "../src/contracts";

const RAW = "/Users/vechkasov/Documents/BB-сервис/.agency/jobs/AG-194/tmp/raw";
mkdirSync(RAW, { recursive: true });

const projectId = "proj_ejbam66722";
const pmThreadId = "pm-bb";
const config = {
  projectId,
  hostId:"host_7sea4qaad8",
  pmWorkspacePath:"/tmp/ag194-pm",
  writerWorkspacePath:"/Users/vechkasov/Documents/BB-сервис/.agency/jobs/AG-194/tmp/fixture-repo",
  pmProviderId:"claude-code",
  pmModel:"claude-test",
  writerProviderId:"codex",
  writerModel:"gpt-5.6-luna",
};

const task: TaskV2 = {
  schema_version:2,
  id:"livefail1",
  title:"Unfulfillable verify",
  risk:"low",
  lane:"writer",
  project_cwd:config.writerWorkspacePath,
  read_first:["README.md"],
  interfaces:["none"],
  invariants:["none"],
  out_of_scope:["plugin"],
  expected_outputs:["hello.txt"],
  owns_paths:["hello.txt"],
  never_touch:[".git/**"],
  depends_on:[],
  objective:"Create hello.txt then fail verify on purpose.",
  acceptance:["never"],
  verify:"tests",
  verification:[{ command:"python3 -m this_module_does_not_exist", cwd:config.writerWorkspacePath, timeout_sec:10 }],
};

const { bb, harness } = createFakePluginHost({
  pluginId:"lane-pilot",
  sdk:{
    threads:{
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId
        ? { role:"pm", lanePilotRunId:"run-bb" }
        : { role:"writer" },
      spawn: async (args) => ({ id:`writer-${String((args.pluginMetadata as {attemptId?:string}).attemptId ?? "x").slice(-6)}` }),
      wait: async () => ({ matched:true, thread:{ status:"idle" } }),
      get: async () => ({ status:"idle" }),
      output: async () => ({ text:"wrote hello.txt" }),
      list: async () => [] as never,
    },
    files:{
      read: async ({ path }) => path.endsWith("hello.txt") ? { content:"hello from native BB writer\n" } : { content:null },
      write: async () => ({ ok:true }),
    },
    hosts:{
      experimental_client: () => ({
        call: async (method: string, input: { command?:string }) => {
          if (method === "runCommand") {
            if ((input.command ?? "").includes("git status")) {
              return { hostId:"host_7sea4qaad8", exitCode:0, stdout:"?? hello.txt\n", stderr:"" };
            }
            return { hostId:"host_7sea4qaad8", exitCode:1, stdout:"", stderr:`failed: ${input.command}` };
          }
          throw new Error(`unexpected host method ${method}`);
        },
      }),
    },
  } as never,
});

const db = openDatabase(bb);
savePrototypeConfig(db, config);
createRun(db, "run-bb", projectId);
setRunThread(db, "run-bb", pmThreadId);
await plugin(bb);
const result = await harness.behavior.callAgentTool(
  "lane_pilot_dispatch_writer",
  { confirm:true, task },
  { threadId:pmThreadId, projectId },
);
const attempts = listAttemptsForTask(db, "run-bb", "livefail1");
const last = attempts.at(-1) ? getAttempt(db, attempts.at(-1)!.id) : null;
const payload = { result, attempts, last };
writeFileSync(`${RAW}/b-bb-retry.json`, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(payload, null, 2));
await harness.lifecycle.dispose();
