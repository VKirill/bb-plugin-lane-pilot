import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

/**
 * invoice-send on stubs: the Elba step, the Jev judgment and the Telegram send answer from stubs, the routing, the owner's questions and
 * the emits are the real engine's. What matters most: nothing is sent unless the owner answered «send», and the send runs once.
 */
const input = { company: "ООО «Ромашка»", inn: "7707083893", amount: 50000, service: "SEO-сопровождение за октябрь", recipient: "@ivan_romashka" };
const created = { status: "done", invoice_number: "142", invoice_url: "https://elba.kontur.ru/invoices/142", pdf_path: "/Users/owner/deals/romashka/invoice-142.pdf", client_name: "ООО «Ромашка»", client_inn: "7707083893",
  invoice_amount: 50000, invoice_service: "SEO-сопровождение за октябрь 2026", pay_bik: "044525225", pay_account: "40702810200000012345", pay_corr_account: "30101810400000000225", payee_inn: "500100732259" };
const base = (extra: Record<string, unknown> = {}) => ({ create: created, check: { verdict: "match", reasons: [], by: "jev" }, send: { status: "sent", message_id: "stub-1", message_url: "https://t.me/c/1/2" }, topic: { message_id: "r-1", status: "ok" }, ...extra });

describe("invoice-send", () => {
  it("a clean invoice goes to the owner's approval, then is sent once; no report chat, no report", async () => {
    const r = await runSim("invoice-send", { input, stubs: base(), humans: { approve: { answer_kind: "send" } } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("create check approve send topic sent");
    expect(r.skipped).toEqual(["topic"]);
    expect(out(r)).toMatchObject({ status: "sent", invoice_number: "142", message_id: "stub-1", check_verdict: "match", pdf_path: created.pdf_path });
    expect(r.called("send")).toHaveLength(1);
    expect(r.called("send")[0]!.input).toMatchObject({ pdf_path: created.pdf_path, invoice_number: "142", amount: 50000, recipient: "@ivan_romashka" });
    expect(r.called("create")[0]!.input).toMatchObject({ company: "ООО «Ромашка»", inn: "7707083893", amount: 50000, service: "SEO-сопровождение за октябрь" });
  });

  it("a report chat gets the one-line report after the send", async () => {
    const r = await runSim("invoice-send", { input: { ...input, report_chat: "-100123/45" }, stubs: base(), humans: { approve: { answer_kind: "send" } } });
    expect(pathOf(r)).toBe("create check approve send topic sent");
    expect(r.skipped).toEqual([]);
    expect(r.called("topic")).toHaveLength(1);
  });

  it("the owner says no: nothing is sent and the run ends aborted with the invoice's data", async () => {
    const r = await runSim("invoice-send", { input, stubs: base(), humans: { approve: { answer_kind: "abort" } } });
    expect(pathOf(r)).toBe("create check approve aborted");
    expect(r.called("send")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "aborted", invoice_number: "142", message_id: "" });
    expect(String(out(r)!.reason)).toContain("nothing was sent");
  });

  it("nobody answers: the question times out and nothing is sent", async () => {
    const r = await runSim("invoice-send", { input, stubs: base(), humans: { approve: { answer_kind: "timeout" } } });
    expect(r.called("send")).toHaveLength(0);
    expect(out(r)).toMatchObject({ status: "aborted" });
  });

  it("a check that is not clean goes to a review first; continue reaches the approval, abort ends the run", async () => {
    for (const verdict of ["mismatch", "unsure"]) {
      const stubs = base({ check: { verdict, reasons: ["the amount in the invoice is 55000, the request says 50000"], by: "rules" } });
      const go = await runSim("invoice-send", { input, stubs, humans: { review: { answer_kind: "continue" }, approve: { answer_kind: "send" } } });
      expect(pathOf(go), verdict).toBe("create check review approve send topic sent");
      expect(out(go), verdict).toMatchObject({ status: "sent", check_verdict: verdict });
      const stop = await runSim("invoice-send", { input, stubs, humans: { review: { answer_kind: "abort" } } });
      expect(pathOf(stop), verdict).toBe("create check review aborted");
      expect(stop.called("send"), verdict).toHaveLength(0);
      const silent = await runSim("invoice-send", { input, stubs, humans: { review: { answer_kind: "timeout" } } });
      expect(silent.called("send"), verdict).toHaveLength(0);
    }
  });

  it("Elba fails: no check, no question, no send; the reason comes out", async () => {
    for (const status of ["blocked", "client_not_found"]) {
      const r = await runSim("invoice-send", { input, stubs: base({ create: { status, reason: status === "blocked" ? "login wall" : "two clients match" } }) });
      expect(pathOf(r), status).toBe("create blocked");
      expect(out(r), status).toMatchObject({ status: "blocked", reason: status === "blocked" ? "login wall" : "two clients match" });
      expect(r.called("send"), status).toHaveLength(0);
    }
  });

  it("a send that failed or may have gone through is reported as such, never retried", async () => {
    const failed = await runSim("invoice-send", { input, stubs: base({ send: { status: "failed", reason: "not logged in to Telegram" } }), humans: { approve: { answer_kind: "send" } } });
    expect(pathOf(failed)).toBe("create check approve send send_failed");
    expect(out(failed)).toMatchObject({ status: "send_failed", reason: "not logged in to Telegram" });
    const unsure = await runSim("invoice-send", { input, stubs: base({ send: { status: "unsure", reason: "the chat did not confirm" } }), humans: { approve: { answer_kind: "send" } } });
    expect(pathOf(unsure)).toBe("create check approve send send_unconfirmed");
    expect(out(unsure)).toMatchObject({ status: "send_unconfirmed" });
    expect(failed.called("send")).toHaveLength(1);
    expect(unsure.called("send")).toHaveLength(1);
  });
});
