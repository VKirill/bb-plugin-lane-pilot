import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyOpenCodeLimit, limitOfError, openCodeServicePath, probeOpenCodeLimit, type OpenCodeAssistantMessage } from "../src/rooms/host-worker/opencode-limit";

const SESSION = "ses_edf6b33f8ffeoOpCtpdDEdJn0G";
const T = Date.parse("2026-10-09T12:48:47.742Z");
const MODEL = { id:"ag/gemini-3.8-flash-high", providerID:"router9", variant:"default" };

// The provider's texts as the router9 / antigravity quota gave them (2026-10-09), now inside OpenCode v2's StructuredError.
const quotaText = `[antigravity/gemini-3.8-flash-medium] [429]: {\n  "error": {\n    "code": 429,\n    "message": "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h43m12s.",\n    "details": [{"metadata": {"quotaResetTimeStamp": "2026-10-09T17:32:00Z"}}]`;
const quota = { type:"provider.error", message:quotaText };
const unavailable = { type:"provider.error", message:"[antigravity/gemini-3.8-flash-high] Unavailable (reset after 2h 7s)" };
const rateLimit = { type:"provider.rate-limit", message:"Too many requests", status:429, retryAfterMs:90_000 };
const badRequest = { type:"provider.error", message:"[400]: Request contains an invalid argument." };

const assistant = (patch: Partial<OpenCodeAssistantMessage>): OpenCodeAssistantMessage => ({ type:"assistant", model:MODEL, time:{ created:T }, ...patch });

describe("limitOfError", () => {
  it("reads the model that hit the limit and the reset stamp from a 429 quota error", () => {
    const limit = limitOfError(quota, T, MODEL);
    expect(limit).toMatchObject({ providerId:"router9", model:"antigravity/gemini-3.8-flash-medium", resetAt:Date.parse("2026-10-09T17:32:00Z") });
    expect(limit?.reason).toContain("Individual quota reached");
  });

  it("counts Unavailable (reset after …) from when the error happened", () => {
    expect(limitOfError(unavailable, T, MODEL)).toMatchObject({ model:"antigravity/gemini-3.8-flash-high", resetAt:T + (2 * 3600 + 7) * 1000 });
  });

  it("takes OpenCode's own type and retryAfterMs, and the session's model when the text names none", () => {
    expect(limitOfError(rateLimit, T, MODEL)).toEqual({ providerId:"router9", model:"router9/ag/gemini-3.8-flash-high", resetAt:T + 90_000, reason:"Too many requests" });
    expect(limitOfError({ type:"provider.quota", message:"" }, T, MODEL)).toMatchObject({ reason:"provider.quota", resetAt:null });
  });

  it("names no limit for an unrelated error", () => {
    expect(limitOfError(badRequest, T, MODEL)).toBeNull();
    expect(limitOfError({ type:"aborted", message:"Aborted" }, T, MODEL)).toBeNull();
  });
});

describe("classifyOpenCodeLimit", () => {
  it("classifies a retry OpenCode scheduled on a limit, while the turn still waits", () => {
    const messages = [assistant({ retry:{ attempt:3, at:T + 5_000, error:rateLimit } })];
    expect(classifyOpenCodeLimit(messages, T)).toMatchObject({ status:"limit", resetAt:T + 5_000 + 90_000 });
  });

  it("classifies the error a turn ended with", () => {
    expect(classifyOpenCodeLimit([assistant({ error:quota, time:{ created:T - 30_000, completed:T } })], T)).toMatchObject({ status:"limit", model:"antigravity/gemini-3.8-flash-medium" });
  });

  it("gives none for an unrelated error, a clean turn and other message types", () => {
    const messages = [assistant({ error:badRequest }), assistant({}), { type:"user", time:{ created:T } }];
    expect(classifyOpenCodeLimit(messages, T - 60_000)).toEqual({ status:"none", providerId:null, model:null, resetAt:null, reason:null });
  });

  it("ignores a limit older than the writer's last event", () => {
    expect(classifyOpenCodeLimit([assistant({ error:quota, time:{ created:T, completed:T } })], T + 10 * 60_000).status).toBe("none");
  });

  it("finds the limit on an older turn when the newest one ended clean but stays within the window", () => {
    const messages = [assistant({ time:{ created:T + 2_000 } }), assistant({ error:unavailable, time:{ created:T, completed:T + 1_000 } })];
    expect(classifyOpenCodeLimit(messages, T).status).toBe("limit");
  });
});

describe("probeOpenCodeLimit", () => {
  let dir = "";
  let env: NodeJS.ProcessEnv = {};
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lp-opencode-service-"));
    await mkdir(join(dir, "opencode"), { recursive:true });
    await writeFile(join(dir, "opencode", "service.json"), JSON.stringify({ id:"x", version:"2.1.2", url:"http://127.0.0.1:49374", pid:1, password:"secret" }));
    env = { XDG_STATE_HOME:dir };
  });
  afterAll(async () => { await rm(dir, { recursive:true, force:true }); });

  it("asks the service for the session's newest assistant messages with its password", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data:[assistant({ retry:{ attempt:1, at:T, error:rateLimit } })] })));
    expect(await probeOpenCodeLimit({ sessionId:SESSION, sinceMs:T, env, fetchImpl:fetchImpl as unknown as typeof fetch })).toMatchObject({ status:"limit", providerId:"router9" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`http://127.0.0.1:49374/api/session/${SESSION}/message?limit=10&order=desc&type=assistant`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`);
  });

  it("throws when the service answers with an error or is not set up, so the caller keeps the nudge", async () => {
    const failing = vi.fn(async () => new Response("no such session", { status:404 }));
    await expect(probeOpenCodeLimit({ sessionId:SESSION, sinceMs:T, env, fetchImpl:failing as unknown as typeof fetch })).rejects.toThrow("opencode_service_http_404");
    await expect(probeOpenCodeLimit({ sessionId:SESSION, sinceMs:T, env:{ XDG_STATE_HOME:join(dir, "missing") } })).rejects.toThrow();
  });

  it("finds service.json under XDG_STATE_HOME, else under ~/.local/state", () => {
    expect(openCodeServicePath({ XDG_STATE_HOME:"/x" })).toBe("/x/opencode/service.json");
    expect(openCodeServicePath({})).toMatch(/\.local\/state\/opencode\/service\.json$/);
  });
});
