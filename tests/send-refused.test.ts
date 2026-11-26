import { describe, expect, it } from "vitest";
import { sendRefused } from "../src/rooms/writer/server/services/reopen-attempt";

// EXT05 review (send-refusal-sdk-contract-audit.md): only BB's dispatch-hook refusal, as the SDK's BbHttpError carries it,
// proves a turn was not queued; every other failure is «not confirmed».
const refusal = (patch: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => Object.assign(new Error("HTTP 409: blocked by a hook"), {
  status: 409, code: "dispatch_rejected",
  body: { code: "dispatch_rejected", message: "blocked by a hook", details: { pluginId: "guard-plugin" }, ...body }, ...patch,
});

describe("sendRefused", () => {
  it("is true for the whole audited tuple: status 409, code and body.code dispatch_rejected, a schema-valid body.details.pluginId", () => {
    expect(sendRefused(refusal())).toBe(true);
  });

  it("is false when any part of the tuple is missing or different, and never reads the message text", () => {
    for (const cause of [
      refusal({ status: 400 }), refusal({ code: "conflict" }), refusal({ body: undefined }),
      refusal({}, { code: "conflict" }), refusal({}, { details: undefined }), refusal({}, { details: {} }),
      refusal({}, { details: { pluginId: "Not A Plugin" } }), refusal({}, { details: { pluginId: 7 } }),
      { status: 409, code: "dispatch_rejected" }, { status: 409 }, { status: 404, code: "not_found" }, { code: "forbidden" },
      new Error("HTTP 409: dispatch_rejected"), new Error("socket hang up"), { status: 502, code: "dispatch_hook_failed" },
      null, undefined, "dispatch_rejected",
    ]) expect(sendRefused(cause), JSON.stringify(cause ?? null)).toBe(false);
  });
});
