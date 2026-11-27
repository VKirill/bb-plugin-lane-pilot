import { createStatusResolver, definitionSha256, type StoredWorkflow } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { runSim } from "./chain-harness";
import { out, pathOf } from "./chain-helpers";
import { journalDb } from "./engine-helpers";

/**
 * Task 20 (`deliver` brick): `invoice-send` dispatches through `deliver` (not `telegram-send` directly);
 * `deliver` routes `channel` -> `telegram` -> stubbed `telegram-send` and returns `sent` / `send_unconfirmed`
 * unchanged to `invoice-send`, which still satisfies `live_success` on `sent`.
 */
const input = {
  company: "ООО «Ромашка»",
  inn: "7707083893",
  amount: 50000,
  service: "SEO-сопровождение за октябрь",
  recipient: "@ivan_romashka",
};

const created = {
  status: "done",
  invoice_number: "142",
  invoice_url: "https://elba.kontur.ru/invoices/142",
  pdf_path: "/Users/owner/deals/romashka/invoice-142.pdf",
  client_name: "ООО «Ромашка»",
  client_inn: "7707083893",
  invoice_amount: 50000,
  invoice_service: "SEO-сопровождение за октябрь 2026",
  pay_bik: "044525225",
  pay_account: "40702810200000012345",
  pay_corr_account: "30101810400000000225",
  payee_inn: "500100732259",
};

describe("deliver brick", () => {
  it("invoice-send -> deliver -> stubbed telegram-send returns sent unchanged and satisfies live_success", async () => {
    const r = await runSim("invoice-send", {
      input,
      stubs: {
        create: created,
        check: { verdict: "match", reasons: [], by: "jev" },
        "telegram-send": {
          status: "sent",
          message_id: "tg-42",
          message_url: "https://t.me/c/1/42",
          schedule_id: "",
          run_at: "",
          send_at: "",
          reason: "",
        },
        topic: { message_id: "r-1", status: "ok" },
      },
      humans: { approve: { answer_kind: "send" } },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("create check approve send topic sent");
    expect(out(r)).toMatchObject({
      status: "sent",
      invoice_number: "142",
      message_id: "tg-42",
      check_verdict: "match",
      pdf_path: created.pdf_path,
    });
    const deliverRun = r.db
      .prepare("SELECT workflow_id, inputs_json, output_json FROM lane_pilot_wf_run WHERE parent_run_id=? AND workflow_id='deliver'")
      .get(r.summary.runId) as { workflow_id: string; inputs_json: string; output_json: string } | undefined;
    expect(deliverRun).toBeTruthy();
    expect(JSON.parse(deliverRun!.inputs_json)).toMatchObject({
      channel: "telegram",
      recipient: "@ivan_romashka",
      file_path: created.pdf_path,
      send_at: "",
    });
    expect(JSON.parse(deliverRun!.output_json)).toMatchObject({
      status: "sent",
      message_id: "tg-42",
    });
    expect(r.called("telegram")[0]!.input).toMatchObject({
      chat: "@ivan_romashka",
      file_path: created.pdf_path,
      send_at: "",
    });
    expect(String(r.called("telegram")[0]!.input.text)).toContain("Счёт № 142 на 50000 ₽");

    const invoice = builtinWorkflow("invoice-send")!;
    expect(invoice.live_success?.in).toContain(out(r)!.status);
    const db = journalDb();
    const resolver = createStatusResolver(db);
    db.prepare(
      "INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,status,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "r-deliver-sent",
      invoice.id,
      invoice.version,
      definitionSha256(invoice),
      "{}",
      "succeeded",
      JSON.stringify(out(r)),
      1,
      1,
    );
    const stored: StoredWorkflow = {
      workflow: invoice,
      origin: "builtin",
      source: "invoice-send.json",
      sha256: definitionSha256(invoice),
      warnings: [],
    };
    expect(resolver.resolve(stored).status).toBe("published");
  });

  it("invoice-send -> deliver -> stubbed telegram-send returns send_unconfirmed unchanged to the parent", async () => {
    const r = await runSim("invoice-send", {
      input,
      stubs: {
        create: created,
        check: { verdict: "match", reasons: [], by: "jev" },
        "telegram-send": {
          status: "send_unconfirmed",
          message_id: "",
          message_url: "",
          schedule_id: "",
          run_at: "",
          send_at: "",
          reason: "the chat did not confirm",
        },
      },
      humans: { approve: { answer_kind: "send" } },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("create check approve send send_unconfirmed");
    expect(out(r)).toMatchObject({
      status: "send_unconfirmed",
      invoice_number: "142",
      message_id: "",
      reason: "the chat did not confirm",
    });
  });

  it("deliver runs standalone through channel decision -> telegram -> done", async () => {
    const r = await runSim("deliver", {
      input: {
        channel: "telegram",
        recipient: "@ivan_romashka",
        text: "Hello",
        file_path: "/tmp/invoice-142.pdf",
      },
      stubs: {
        "telegram-send": {
          status: "sent",
          message_id: "tg-99",
          message_url: "https://t.me/c/1/99",
          schedule_id: "",
          run_at: "",
          send_at: "",
          reason: "",
        },
      },
    });

    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("channel telegram done");
    expect(out(r)).toMatchObject({
      status: "sent",
      message_id: "tg-99",
      message_url: "https://t.me/c/1/99",
    });
  });
});
