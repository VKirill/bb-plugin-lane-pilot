# The graph library grows by itself (plan, 2026-11-02)

Owner's ask (thread thr_6pwx5dw9f8, 2026-11-02 02:00 Madrid): «больше самодостаточности: я могу не знать, какой граф у нас есть;
Штурман должен сам доводить, тестировать и создавать графы под категории; граф бухгалтерии выставляет счёт, граф телеграма
отправляет; графы должны появляться сами там, где их ещё нет». Checked against Maslov's laws (docs/audits/maslov-graphs-vs-lane-pilot.md):
law 9 «small graphs, many; every new process enters the codex as a small graph», law 8 «a change of the graph only with the owner's
yes while there are no rollbacks», and the lead's rights model (rights earned by the exam, `policy/lead-policy.json`, class `process`).

## What is true today (0.1.476)

- 56 offered graphs with tags (`finance`, `telegram`, `social`, `code`…): the tags are the categories; the router (`lane_pilot_route`,
  Jev `route.workflow`) picks one graph for the whole request. Composition exists as `subworkflow` nodes of `internal` fragments
  (social-post → insights-post); `invoice-send` has its own `send` node instead of a shared Telegram fragment.
- The owner never has to know a graph: the PM routes. The fallback graph `errand` routes its own brief too, but only to **one**
  graph (`api-recon`, confidence ≥ 96, `src/rooms/qa/server/errand-graph.ts` apiRecon). Two invoices this week ran as errands
  although `invoice-send` routed at 95 and 70.
- Nothing notices work done by hand again and again: 22 errands this week, 7 of them the same Blender/GPU process, no graph, no
  proposal. The Workflow architect is opened by the owner by hand. The lead («Штурман») has the class `process` («a hand-over of
  a process to the architect», tier `proposes`) but no data about graph-less work in its snapshot (`src/rooms/lead/server/tick.ts`).

## The loop we build

1. **Request → graph, PM not needed** (G1): the errand routes its brief over the whole offered catalog; a sure match (≥ 90) runs
   that graph (a `tested` one as its first live run, 0.1.476 rule); every errand records its best candidate and confidence.
2. **Graph-less work → a proposal** (G2): the lead's snapshot lists processes done by errands ≥ 3 times in 30 days without a graph
   (count, cost, samples, threads); the tick proposes class `process` «граф для …»; the owner's «да» opens the architect seeded
   with those errand threads. The exam moves `process` to `decides` once the proposals prove right (Wilson LB ≥ 0.8, N ≥ 20).
3. **Architect from receipts** (G4, after G2 shows its first proposals): the draft is seeded from what the helpers actually did
   (their threads' steps), tested on stubs, and the next real request is its first live run.
4. **Shared fragments by category** (G3 first, the owner's case): `telegram-send` (internal) with an optional send time; `invoice-send`
   sends through it; `x-to-telegram-digest` and `social-post` follow when touched.

## Streams (SWE-2, worktrees under ~/BB-service/wt/, base 4eefa435)

| Stream | Branch | Owns | Brief |
|---|---|---|---|
| G1 errand self-route | swe2/g1-errand-route | `src/rooms/qa/server/errand-graph.ts`, `workflows/errand.json`, errand tests | `.bb/chats/thr_6pwx5dw9f8/tmp/brief-g1.md` |
| G2 graph-less ledger → lead | swe2/g2-graphless-lead | `src/rooms/lead/**`, `workflows/lead-tick.json`, lead tests | `brief-g2.md` |
| G3 telegram-send fragment | swe2/g3-telegram-send | `workflows/telegram-send.json`, `workflows/invoice-send.json`, `docs/invoice-send.md`, invoice tests | `brief-g3.md` |

G4 (architect seeded from receipts) is written after G2 lands and the first proposals are read.

## Not doing

- Category-first routing (pick `finance`, then the graph): the router's eval (30 phrases) is green; revisit only if G1's ledger shows
  wrong matches between graphs of one tag.
- Creating graphs without any owner word: law 8 and the rights model say the word stays until the class earns `decides`.
