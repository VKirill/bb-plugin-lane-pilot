import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * telegram-send on stubs: the helper's send answers from stubs, the routing (send now vs refuse a delay) and the emits are the
 * real engine's. send_at is declared but a chain cannot create a schedule yet, so any send_at ends cannot_delay with the input
 * echoed back — nothing is sent, no schedule row exists.
 */
const sent = { status: "sent", message_id: "stub-1", message_url: "https://t.me/c/1/2" };

describe("telegram-send", () => {
  it("a text and a file go to the chat, once; the run ends sent", async () => {
    const r = await runSim("telegram-send", { input: { chat: "@ivan", text: "Счёт № 142", file_path: "/tmp/invoice-142.pdf" }, stubs: { send: sent } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("send report sent");
    expect(r.skipped).toEqual(["report"]);
    expect(r.called("send")).toHaveLength(1);
    expect(r.called("send")[0]!.input).toMatchObject({ chat: "@ivan", file_path: "/tmp/invoice-142.pdf" });
    expect(out(r)).toMatchObject({ status: "sent", message_id: "stub-1" });
  });

  it("a report chat gets the one-line report", async () => {
    const r = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi", report_chat: "-100123/45" }, stubs: { send: sent, report: { message_id: "r-1", status: "ok" } } });
    expect(pathOf(r)).toBe("send report sent");
    expect(r.called("report")).toHaveLength(1);
    expect(out(r)).toMatchObject({ status: "sent" });
  });

  it("send_at set: the run ends cannot_delay naming the input; nothing is sent", async () => {
    for (const sendAt of ["2026-11-03T07:00", "+2h", "tomorrow morning", "1999-01-01T00:00"]) {
      const r = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi", send_at: sendAt }, stubs: { send: sent } });
      expect(pathOf(r), sendAt).toBe("send cannot_delay");
      expect(r.skipped, sendAt).toEqual(["send"]);
      expect(r.called("send"), sendAt).toHaveLength(0);
      expect(out(r), sendAt).toMatchObject({ status: "cannot_delay", send_at: sendAt });
      expect(String(out(r)!.reason), sendAt).toContain("send_at");
    }
  });

  it("a send that failed or may have gone through is reported as such, never retried", async () => {
    const failed = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi" }, stubs: { send: { status: "failed", reason: "not logged in" } } });
    expect(pathOf(failed)).toBe("send send_failed");
    expect(out(failed)).toMatchObject({ status: "send_failed", reason: "not logged in" });
    const unsure = await runSim("telegram-send", { input: { chat: "@ivan", text: "hi" }, stubs: { send: { status: "unsure", reason: "no confirmation" } } });
    expect(pathOf(unsure)).toBe("send send_unconfirmed");
    expect(out(unsure)).toMatchObject({ status: "send_unconfirmed" });
    expect(failed.called("send")).toHaveLength(1);
    expect(unsure.called("send")).toHaveLength(1);
  });
});
