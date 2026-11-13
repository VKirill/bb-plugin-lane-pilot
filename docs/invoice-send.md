# invoice-send: an invoice in Kontur.Elba, checked, approved and sent

`workflows/invoice-send.json`, status **tested** (on stubs: `tests/workflow/chains-invoice.test.ts`, `tests/invoice-rules.test.ts`). It becomes
published after one successful live run. Nothing is sent without the owner's «send».

```mermaid
flowchart LR
  I["inputs: company, inn?, amount, service, recipient, report_chat?"] --> C["create (errand, Mac mini browser)\nkontur-elba skill: find the client, make or find the invoice, read it back, download the PDF"]
  C -->|"client_not_found / blocked"| B["emit blocked + reason"]
  C -->|done| K{"check (rules)\namount, INN, BIK, accounts; client and service line"}
  K -->|match| A["approve (owner): send invoice N for X to chat Y?"]
  K -->|"mismatch / unsure"| R["review (owner): continue or stop"]
  R -->|continue| A
  R -->|"stop / no answer"| X["emit aborted"]
  A -->|send| S["send (errand, telegram-user): the PDF as a file, once"]
  A -->|"abort / no answer"| X
  S -->|sent| T["topic: one line to report_chat (skipped when empty)"] --> D["emit sent"]
  S -->|failed| F["emit send_failed"]
  S -->|unsure| U["emit send_unconfirmed"]
```

## Inputs and result

| Input | |
| --- | --- |
| `company` (required) | the client as it is in Elba: name or INN. The client must exist; the chain never creates a client or a contract |
| `inn` | the INN when the owner gave it: it is then compared with the invoice |
| `amount` (required) | the total in RUB, exactly as it must stand in the invoice (final, never recalculated) |
| `service` (required) | what the invoice is for, in the owner's words |
| `recipient` (required) | the Telegram chat that gets the PDF: `@username`, a numeric id, a link, or `me` (Saved Messages) |
| `send_at` | send the invoice later (a delay `+2h`, `30m`, or a local time in the owner's zone `2026-11-03T07:00`): the approval form asks for the timed send, then `telegram-send` puts one send on the schedule board and the run ends `scheduled` (`schedule_id`, `run_at`); a text that is no time ends `cannot_delay` |
| `report_chat` | a chat or project topic for a one-line report after the send; empty: none |

Mail is not offered: there is no mail skill. The send itself is the shared fragment `telegram-send` (docs/telegram-send.md): `send` is a subworkflow
node that hands it the chat, the PDF path, the caption line and `send_at`. The result: `status` (`sent`, `scheduled`, `aborted`, `blocked`, `send_failed`,
`send_unconfirmed`, `cannot_delay`), `invoice_number`, `invoice_url`, `pdf_path` (on the Mini), `message_id`, `schedule_id`, `run_at`, `send_at`, `check_verdict`, `reason`.

## The check (`invoice.check`, the rules in packages/kit, `invoiceVerdict`)

Code decides what code can: the invoice has a number and an amount, the amount equals the request (to half a kopeck), the client's INN has valid control
digits and equals the request's `inn`, the BIK is a Russian one, the payment and correspondent accounts have valid control digits for that BIK. The client
and the service line are compared by the words they share (the share of the shorter text's words the other has, legal forms ignored). Both agree
(0.6 for the client, 0.5 for the service line): `match`; a hard check failed: `mismatch`; otherwise `unsure`. No model is asked; `unsure` goes to the owner's review.
The step's output carries `by: "rules"`.

## Live run: the exact steps (needs the owner's real test invoice; do not do this from an agent)

Before: the build with this chain is on the hub; the project has an open Lane Pilot PM chat; on the Mac mini (`host_7sea4qaad8`) the Elba session works
(`browser-cookies sync elba`, open `https://elba.kontur.ru` in the headless session: the organization is selected, no login form), `~/toolkit/telegram/tg`
is logged in; there is a test client in Elba whose invoices the owner is happy to cancel.

1. Preflight: Workflows tab, invoice-send, or `bb plugin rpc call lane-pilot workflow_preflight --input '{"id":"invoice-send","projectId":"<project>"}'`. Every line must be ok (skills `kontur-elba`, `browser-automation`, `telegram-user`, the plugin `browser-automation`, the tools).
2. Start it as a first live run (the chain is `tested`, so this needs `liveTrial`): the **Run for real** button of the Workflows tab with
   `company` = the test client, `inn` = its INN, `amount` = `100`, `service` = `Тест Lane Pilot`, `recipient` = `me`, `report_chat` empty; or
   `bb plugin rpc call lane-pilot workflow_run --input '{"id":"invoice-send","projectId":"<project>","liveTrial":true,"inputs":{"company":"<client>","inn":"<inn>","amount":100,"service":"Тест Lane Pilot","recipient":"me"}}'`.
3. Watch `workflow_run_snapshot` (the run id comes back): `create` takes minutes in the browser; `check` is instant. Read its output: `verdict`, `reasons`, `by`.
4. A form opens in the project's PM chat (and on the phone): the review (only if the check was not clean) and then «Send invoice N for 100 RUB to … to Telegram chat me?». Answer **send**.
5. Check the result against the sources: the PDF arrived in Saved Messages with the caption; open the invoice in Elba and compare number, total, service line, client and the payment details with the PDF and with the run's output (`invoice_number`, `invoice_url`, `pdf_path`).
6. Run it a second time with the same inputs and answer **abort**: the Elba step must find the invoice of the first run (same client, same amount, same day) and not make a duplicate, and nothing is sent (`status: aborted`). The review path (a check that is not clean) is covered on stubs only; it cannot be provoked live, because the Elba step makes the invoice with the requested amount.
7. A success makes the chain **published** (status in the Workflows tab). Cancel or delete the test invoice in Elba (do not mark it paid or signed).

If a step fails: `create` blocked with a login wall means the Mini session expired (sync the cookies again, no password is asked or stored); `client_not_found` means the
search did not give exactly one client; `send_unconfirmed` means read the chat before anything is sent again.

## Scheduling it

Once published, the schedule board can run it: a task `{"kind":"workflow","workflowId":"invoice-send","inputs":{...}}` with `when` `{"type":"cron","cron":"0 10 1 * *"} (the owner's time zone)`.
A scheduled run still asks the owner before the send; it waits in the «waiting for you» column (up to 72 hours, then it is given up and nothing is sent), and the
overlap policy `skip` keeps a second month from starting while the first waits.
