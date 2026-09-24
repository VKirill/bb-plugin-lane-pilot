import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPlan } from "../src/host-handlers";
import { automaticEffortRoutingEnabled, bbServiceTier, resolveJevReasoning, writerExecutionSelection, writerServiceTier } from "../src/jev-reasoning";

const { missingCredentialFile } = vi.hoisted(() => ({ missingCredentialFile:{ value:false } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) =>
    missingCredentialFile.value ? Promise.reject(new Error("ENOENT")) : actual.readFile(...args) };
});

const priorFetch = globalThis.fetch;
const priorEnv = { typesafe:process.env.TYPESAFE_API_KEY, jev:process.env.JEV_API_KEY };

afterEach(() => {
  missingCredentialFile.value = false;
  globalThis.fetch = priorFetch;
  if (priorEnv.typesafe === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = priorEnv.typesafe;
  if (priorEnv.jev === undefined) delete process.env.JEV_API_KEY;
  else process.env.JEV_API_KEY = priorEnv.jev;
  vi.restoreAllMocks();
});

describe("Lane Pilot Jev complete-plan adapter", () => {
  it.each(["medium", "high", "xhigh"] as const)("forwards supported %s unchanged to explicit BB execution selection", (level) => {
    const selected = writerExecutionSelection("codex", "gpt-test", level, "fast");
    const decision = resolveJevReasoning({ status:"ok", jevDecision:level, manualLevel:"medium", supportedLevels:new Set(["medium","high","xhigh"]) });
    expect(decision).toMatchObject({ requested:level, effective:level, fallbackReason:null });
    expect(selected).toMatchObject({ providerId:"codex", model:"gpt-test", reasoningLevel:level, serviceTier:"fast",
      executionInputSources:{ providerId:"explicit", model:"explicit", reasoningLevel:"explicit", serviceTier:"explicit" } });
  });

  it("migrates legacy fast mode into service tier without changing reasoning", () => {
    expect(writerServiceTier({ "writer.fast_mode":true })).toBe("fast");
    expect(writerServiceTier({ "writer.fast_mode":false })).toBe("standard");
    expect(writerServiceTier({ "writer.fast_mode":true, "writer.service_tier":"standard" })).toBe("standard");
    expect(bbServiceTier("standard")).toBe("default");
    expect(bbServiceTier("fast")).toBe("fast");
    expect(writerExecutionSelection("codex", "gpt-6-luna", "medium", "fast").reasoningLevel).toBe("medium");
    expect(writerExecutionSelection("codex", "gpt-6-luna", "high", "fast", { reasoningLevel:"client-preference" }).executionInputSources.reasoningLevel)
      .toBe("client-preference");
    expect(automaticEffortRoutingEnabled({ "jev.LANE_JEV_EFFORT":true })).toBe(true);
    expect(automaticEffortRoutingEnabled({ "jev.LANE_JEV_EFFORT":"0" })).toBe(false);
  });

  it("uses the selected manual effort for unsupported decisions, timeout, and disabled Jev", () => {
    const supported = new Set(["medium", "high"]);
    expect(resolveJevReasoning({ status:"ok", jevDecision:"xhigh", manualLevel:"high", supportedLevels:supported }))
      .toMatchObject({ requested:"xhigh", effective:"high", fallbackReason:"jev_unsupported_by_selected_model:xhigh", manualSupported:true });
    expect(resolveJevReasoning({ status:"timeout", jevDecision:null, manualLevel:"high", supportedLevels:supported }))
      .toMatchObject({ requested:"high", effective:"high", fallbackReason:"jev_timeout", manualSupported:true });
    expect(resolveJevReasoning({ status:"disabled", jevDecision:null, manualLevel:"medium", supportedLevels:supported }))
      .toMatchObject({ requested:"medium", effective:"medium", fallbackReason:"jev_disabled", manualSupported:true });
    expect(resolveJevReasoning({ status:"error", jevDecision:null, manualLevel:"xhigh", supportedLevels:supported }).manualSupported).toBe(false);
  });

  it("sends the complete canonical plan as the only state and keeps classifier questions separate", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    const bodies:string[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ answers:{ effort:{ choice:"high", confidence:0.92 } } }), { status:200 });
    }) as typeof fetch;
    const prefix = "Task step. ".repeat(220);
    const planA = `${prefix}\n🧭 Критический шаг в хвосте: preserve newline\nCRITICAL_TAIL_ALPHA`;
    const planB = `${prefix}\n🧭 Критический шаг в хвосте: preserve newline\nCRITICAL_TAIL_BETA`;
    const a = await classifyPlan({ requestedHostId:"host-a", plan:planA }, {} as never);
    const b = await classifyPlan({ requestedHostId:"host-a", plan:planB }, {} as never);
    const requestA = JSON.parse(bodies[0]!);
    const requestB = JSON.parse(bodies[1]!);
    expect(requestA).toMatchObject({ model:"jev-latest", state:{ task:planA }, questions:{ effort:{ type:"choice" } } });
    expect(requestB.state.task).toBe(planB);
    expect(requestA.state.task).not.toContain("writer prompt");
    expect(requestA.state.task).not.toContain("AGENTS.md");
    expect(requestA.state.task).not.toContain("system instructions");
    expect(a).toMatchObject({ status:"ok", effort:"high", sourceLength:Buffer.byteLength(planA), sentLength:Buffer.byteLength(planA) });
    expect(a.sentPlanSha256).toBe(a.planSha256);
    expect(b).toMatchObject({ status:"ok", planSha256:expect.not.stringMatching(a.planSha256) });
  });

  it("reports disabled, HTTP errors, and timeouts without returning truncated plan text", async () => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_API_KEY;
    missingCredentialFile.value = true;
    expect(await classifyPlan({ requestedHostId:"host-a", plan:"Full plan" }, {} as never)).toMatchObject({ status:"disabled", reason:"missing_typesafe_api_key" });
    missingCredentialFile.value = false;
    process.env.JEV_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => new Response("private server response", { status:503 })) as typeof fetch;
    expect(await classifyPlan({ requestedHostId:"host-a", plan:"Full plan" }, {} as never)).toMatchObject({ status:"error", reason:"http_503" });
    globalThis.fetch = vi.fn(async () => { const error = new Error("timeout"); error.name = "TimeoutError"; throw error; }) as typeof fetch;
    expect(await classifyPlan({ requestedHostId:"host-a", plan:"Full plan" }, {} as never)).toMatchObject({ status:"timeout", reason:"timeout" });
  });
});
