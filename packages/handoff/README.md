# @lane-pilot/handoff

A handoff is a task one agent gives to another as a card, not as free text: what to achieve, how
the result is accepted, what inputs to use, how much it may cost, by when, and who owns it. The card
has a life cycle with receipts, so the sender and a human can always see where it is.

```text
queued ─► delivered ─► accepted ─► in_progress ─► done
   │           │            │            │        ├─► blocked
   │           │            │            │        └─► rejected
   └───────────┴────────────┴────────────┴──────────► canceled / expired
```

## Contract

| Export | What it does |
|---|---|
| `handoffCardSchema`, `HandoffCard` | The card: objective, acceptance, inputs, budget, deadline, sender, recipient |
| `parseHandoffCard(raw)` | Validates a card a model produced (JSON, fenced or not) |
| `handoffReceiptSchema`, `parseHandoffReceipt(raw)` | The recipient's answer: `done`, `blocked` or `rejected`, with summary, outputs and evidence |
| `canTransition(from, to)`, `HANDOFF_TRANSITIONS` | The legal state machine |
| `handoffMigrations` | SQL the host plugin appends to its migrations |
| `createHandoff`, `getHandoff`, `listHandoffs`, `transitionHandoff`, `recordHandoffReceipt` | Store operations over better-sqlite3 |
| `claimHandoffLease`, `renewHandoffLease`, `releaseHandoffLease` | One holder at a time, with expiry |
| `expireOverdueHandoffs(db, now)` | Moves cards past their deadline to `expired` |
| `buildCapabilityRegistry(agents)`, `chooseRecipient(registry, request)` | Who should get a request, from agent definitions |
| `handoffMessage(card)` | The text delivered to the recipient's thread, with the receipt format it must answer with |

Delivery itself (sending the message into a BB thread) belongs to the host plugin; this package only
produces the message and records what happened.

## Who may use it

Lane Pilot's PM and specialists, a council chair handing work to a seat, or any plugin that lets one
agent give work to another and wants the exchange to be visible and accountable.
