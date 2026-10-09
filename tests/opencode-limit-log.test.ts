import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyOpenCodeLimit, limitOfLine, openCodeLogPath, probeOpenCodeLimit } from "../src/rooms/host-worker/opencode-limit-log";

const SESSION = "ses_edf6b33f8ffeoOpCtpdDEdJn0G";
const OTHER = "ses_edfc75066ffeGxh7U60dkYLTBr";
const T = Date.parse("2026-10-09T12:48:47.742Z");

// Lines as OpenCode writes them on the writer host (2026-10-09, router9 / antigravity quota).
const quotaStream = `timestamp=2026-10-09T12:48:47.742Z level=ERROR run=b505168e message="stream error" providerID=router9 modelID=ag/gemini-3.8-flash-high session.id=${SESSION} small=false agent=build mode=primary error.error="AI_APICallError: [antigravity/gemini-3.8-flash-medium] [429]: {\\n  \\"error\\": {\\n    \\"code\\": 429,\\n    \\"message\\": \\"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h43m12s.\\",\\n    \\"details\\": [{\\"metadata\\": {\\"quotaResetTimeStamp\\": \\"2026-10-09T17:32:00Z\\"}}]"`;
const quotaTelemetry = `timestamp=2026-10-09T12:48:47.737Z level=ERROR run=b505168e message=telemetry t=2026-10-09T12:48:47.737Z src=lane mod=telemetry ok=false session=${SESSION} err="[antigravity/gemini-3.8-flash-medium] [429]: {\\"error\\": {\\"code\\": 429, \\"message\\": \\"Individual quota reached. Resets in 4h43m12s.\\"}}" data.event=session.retry data.attempt=1`;
const unavailable = `timestamp=2026-10-09T13:50:54.774Z level=ERROR run=60675066 message="stream error" providerID=router9 modelID=ag/gemini-3.8-flash-medium session.id=${SESSION} small=false agent=build mode=primary error.error="AI_APICallError: [antigravity/gemini-3.8-flash-high] Unavailable (reset after 2h 7s)"`;
const unrelatedError = `timestamp=2026-10-09T12:50:00.000Z level=ERROR run=b505168e message="tool failed" session.id=${SESSION} error.error="ENOENT: no such file or directory, open '/tmp/x'"`;
const otherSessionQuota = `timestamp=2026-10-09T12:49:00.000Z level=ERROR run=1f0e4374 message="stream error" providerID=router9 modelID=ag/gemini-3.8-flash-high session.id=${OTHER} error.error="AI_APICallError: [antigravity/gemini-3.8-flash-medium] [429]: quota"`;
const infoLine = `timestamp=2026-10-09T12:49:30.000Z level=INFO run=b505168e message="turn started" session.id=${SESSION}`;

describe("limitOfLine", () => {
  it("reads the model that hit the limit and the reset time from a 429 quota line", () => {
    const limit = limitOfLine(quotaStream);
    expect(limit).toMatchObject({ providerId:"router9", model:"antigravity/gemini-3.8-flash-medium", resetAt:Date.parse("2026-10-09T17:32:00Z") });
    expect(limit?.reason).toContain("Individual quota reached");
  });

  it("reads Unavailable (reset after …) relative to the line's own timestamp", () => {
    expect(limitOfLine(unavailable)).toMatchObject({ model:"antigravity/gemini-3.8-flash-high", resetAt:Date.parse("2026-10-09T13:50:54.774Z") + (2 * 3600 + 7) * 1000 });
  });

  it("names no limit for an unrelated error", () => {
    expect(limitOfLine(unrelatedError)).toBeNull();
  });
});

describe("classifyOpenCodeLimit", () => {
  it("classifies the evidence lines of the writer's session as limit", () => {
    const log = [quotaStream, quotaTelemetry].join("\n");
    // The telemetry line is the newest: it names the model and the reset from its own «Resets in» text.
    expect(classifyOpenCodeLimit(log, SESSION, T)).toMatchObject({ status:"limit", model:"antigravity/gemini-3.8-flash-medium", resetAt:Date.parse("2026-10-09T12:48:47.737Z") + (4 * 3600 + 43 * 60 + 12) * 1000 });
  });

  it("classifies a session's Unavailable line as limit", () => {
    expect(classifyOpenCodeLimit(unavailable, SESSION, Date.parse("2026-10-09T13:50:00Z"))).toMatchObject({ status:"limit", resetAt:Date.parse("2026-10-09T15:51:01.774Z") });
  });

  it("gives none for another session's limit, an unrelated error and an info line", () => {
    expect(classifyOpenCodeLimit([otherSessionQuota, unrelatedError, infoLine].join("\n"), SESSION, T - 60_000)).toEqual({ status:"none", providerId:null, model:null, resetAt:null, reason:null });
  });

  it("ignores limit lines older than the writer's last event", () => {
    expect(classifyOpenCodeLimit([quotaStream, quotaTelemetry].join("\n"), SESSION, T + 10 * 60_000).status).toBe("none");
  });

  it("gives limit when a newer unrelated error follows the session's limit line", () => {
    expect(classifyOpenCodeLimit([quotaStream, unrelatedError].join("\n"), SESSION, T - 60_000).status).toBe("limit");
  });
});

describe("probeOpenCodeLimit", () => {
  let dir = "";
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "opencode-limit-")); });
  afterAll(async () => { await rm(dir, { recursive:true, force:true }); });

  it("reads the log's tail and classifies the session", async () => {
    const logPath = join(dir, "opencode.log");
    await writeFile(logPath, `${otherSessionQuota}\n${quotaStream}\n${quotaTelemetry}\n`);
    expect(await probeOpenCodeLimit({ sessionId:SESSION, sinceMs:T, logPath })).toMatchObject({ status:"limit" });
    expect(await probeOpenCodeLimit({ sessionId:OTHER, sinceMs:T, logPath })).toMatchObject({ status:"limit", providerId:"router9" });
    expect(await probeOpenCodeLimit({ sessionId:"ses_nothere", sinceMs:T, logPath })).toMatchObject({ status:"none" });
  });

  it("does not see a limit that is older than the tail it reads", async () => {
    const logPath = join(dir, "big.log");
    const filler = `${infoLine}\n`.repeat(Math.ceil((2 * 1024 * 1024 + 1) / infoLine.length + 1));
    await writeFile(logPath, `${quotaStream}\n${filler}`);
    expect(await probeOpenCodeLimit({ sessionId:SESSION, sinceMs:T, logPath })).toMatchObject({ status:"none" });
  });

  it("throws for a missing log, so the caller keeps the nudge", async () => {
    await expect(probeOpenCodeLimit({ sessionId:SESSION, sinceMs:T, logPath:join(dir, "missing.log") })).rejects.toThrow();
  });

  it("finds the log under XDG_DATA_HOME, else under ~/.local/share", () => {
    expect(openCodeLogPath({ XDG_DATA_HOME:"/data" })).toBe("/data/opencode/log/opencode.log");
    expect(openCodeLogPath({})).toMatch(/\.local\/share\/opencode\/log\/opencode\.log$/);
  });
});
