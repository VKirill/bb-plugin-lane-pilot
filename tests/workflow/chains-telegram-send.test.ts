import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * telegram-send on stubs: the helper's send and the schedule step answer from stubs, the routing (send now, put off, refuse a time) and
 * the emits are the real engine's. `later` is skipped without send_at; with it the step puts one run on the schedule board (its own code:
 * tests/schedule/schedule-create.test.ts) and nothing is sent now.
 */
const sent = { status: "sent", message_id: "stub-1", message_url: "https://t.me/c/1/2" };

describe("telegram-send", () => {
  it("a text and a file go to the chat, once; the run ends sent", async () => {
    const r = await runSim("telegram-send", { input: { chat: "@ivan", text: "Счёт № 142", file_path: "/tmp/invoice-142.pdf" }, stubs: { send: sent } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("later send report sent");
    expect(r.skipped).toEqual(["later", "report"]);
    expect(r.called("send")).toHaveLength(1);
    expect(r.called("send")[0]!.input).toMatchObject({ chat: "@ivan", file_path: "/tmp/invoice-142.pdf" });
    expect(out(r)).toMatchObject({ status: "sent", message_id: "stub-1" });
  });

  it("a report chat gets the one-line report", async () => {
    const r = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi", report_chat: "-100123/45" }, stubs: { send: sent, report: { message_id: "r-1", status: "ok" } } });
    expect(pathOf(r)).toBe("later send report sent");
    expect(r.called("report")).toHaveLength(1);
    expect(out(r)).toMatchObject({ status: "sent" });
  });

  it("send_at set: one run goes on the schedule board, the run ends scheduled and nothing is sent now", async () => {
    const r = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi", send_at: "2026-11-03T07:00" }, stubs: { send: sent, later: { status: "scheduled", schedule_id: "sch-1", run_at: "2026-11-03 07:00" } } });
    expect(pathOf(r)).toBe("later scheduled");
    expect(r.called("later")).toHaveLength(1);
    expect(r.called("send")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "scheduled", schedule_id: "sch-1", run_at: "2026-11-03 07:00", send_at: "2026-11-03T07:00" });
  });

  it("a send_at that is no time ends cannot_delay with the reason; nothing is sent", async () => {
    const r = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi", send_at: "tomorrow morning" }, stubs: { send: sent, later: { status: "cannot_delay", reason: "«tomorrow morning» is not a time" } } });
    expect(pathOf(r)).toBe("later cannot_delay");
    expect(r.called("send")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "cannot_delay", send_at: "tomorrow morning", reason: "«tomorrow morning» is not a time" });
  });

  it("a send that failed or may have gone through is reported as such, never retried", async () => {
    const failed = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi" }, stubs: { send: { status: "failed", reason: "not logged in" } } });
    expect(pathOf(failed)).toBe("later send send_failed");
    expect(out(failed)).toMatchObject({ status: "send_failed", reason: "not logged in" });
    const unsure = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi" }, stubs: { send: { status: "unsure", reason: "no confirmation" } } });
    expect(pathOf(unsure)).toBe("later send send_unconfirmed");
    expect(out(unsure)).toMatchObject({ status: "send_unconfirmed" });
    expect(failed.called("send")).toHaveLength(1);
    expect(unsure.called("send")).toHaveLength(1);
  });
});
