import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * invoice-send with `send_approved`: the owner's own request already said «send», so a clean check goes straight to the
 * send — the approve / approve_later question is not asked again. Without the input (or with it false) the graph asks
 * exactly as before, and a not-clean check still asks the review question first.
 */
const input = { company: "ООО «Ромашка»", inn: "7707083893", amount: 50000, service: "SEO-сопровождение за октябрь", recipient: "@ivan_romashka" };
const created = { status: "done", invoice_number: "142", invoice_url: "https://elba.kontur.ru/invoices/142", pdf_path: "/Users/owner/deals/romashka/invoice-142.pdf", client_name: "ООО «Ромашка»", client_inn: "7707083893",
  invoice_amount: 50000, invoice_service: "SEO-сопровождение за октябрь 2026", pay_bik: "044525225", pay_account: "40702810200000012345", pay_corr_account: "30101810400000000225", payee_inn: "500100732259" };
const base = (extra: Record<string, unknown> = {}) => ({ create: created, check: { verdict: "match", reasons: [], by: "jev" }, send: { status: "sent", message_id: "stub-1", message_url: "https://t.me/c/1/2" }, topic: { message_id: "r-1", status: "ok" }, ...extra });

describe("invoice-send: the owner already said send", () => {
  it("send_approved true and a clean check: create, check, send, topic, sent — approve and approve_later are never asked", async () => {
    const r = await runSim("invoice-send", { input: { ...input, send_approved: true }, stubs: base() });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("create check send topic sent");
    expect(r.called("approve")).toHaveLength(0);
    expect(r.called("approve_later")).toHaveLength(0);
    expect(r.called("review")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "sent", invoice_number: "142", message_id: "stub-1", check_verdict: "match" });
    expect(r.called("send")).toHaveLength(1);
  });

  it("send_approved true with send_at set and a clean check: scheduled, approve_later never asked", async () => {
    const r = await runSim("invoice-send", {
      input: { ...input, send_approved: true, send_at: "2026-11-03T07:00" },
      stubs: base({ send: { status: "scheduled", schedule_id: "sch-1", run_at: "2026-11-03 07:00" } }),
    });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("create check send scheduled");
    expect(r.called("approve")).toHaveLength(0);
    expect(r.called("approve_later")).toHaveLength(0);
    expect(r.called("send")[0]!.input).toMatchObject({ channel: "telegram", recipient: "@ivan_romashka", send_at: "2026-11-03T07:00" });
    expect(out(r)).toMatchObject({ status: "scheduled", send_at: "2026-11-03T07:00", schedule_id: "sch-1", run_at: "2026-11-03 07:00" });
  });

  it("send_approved true and a not-clean check: review is still asked; continue goes straight to send without approve", async () => {
    const stubs = base({ check: { verdict: "mismatch", reasons: ["the amount in the invoice is 55000, the request says 50000"], by: "rules" } });
    const go = await runSim("invoice-send", { input: { ...input, send_approved: true }, stubs, humans: { review: { answer_kind: "continue" } } });
    expect(go.summary.status).toBe("succeeded");
    expect(pathOf(go)).toBe("create check review send topic sent");
    expect(go.called("approve")).toHaveLength(0);
    expect(go.called("approve_later")).toHaveLength(0);
    expect(out(go)).toMatchObject({ status: "sent", check_verdict: "mismatch" });
    const stop = await runSim("invoice-send", { input: { ...input, send_approved: true }, stubs, humans: { review: { answer_kind: "abort" } } });
    expect(pathOf(stop)).toBe("create check review aborted");
    expect(stop.called("send")).toHaveLength(0);
    expect(out(stop)).toMatchObject({ status: "aborted" });
  });

  it("send_approved omitted or false and a clean check: approve is asked before the send, as before", async () => {
    for (const sendApproved of [undefined, false]) {
      const r = await runSim("invoice-send", { input: { ...input, ...(sendApproved === undefined ? {} : { send_approved: sendApproved }) }, stubs: base(), humans: { approve: { answer_kind: "send" } } });
      expect(r.summary.status).toBe("succeeded");
      expect(pathOf(r)).toBe("create check approve send topic sent");
      expect(out(r)).toMatchObject({ status: "sent", invoice_number: "142" });
    }
  });
});
