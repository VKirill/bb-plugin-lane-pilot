---
title: Handoff message
type: component
created: 2026-10-16
updated: 2026-10-17
status: active
confidence: medium
tags: [handoff, messages, agents]
sources:
  - packages/handoff/src/messages.ts
  - packages/handoff/src/contract.ts
  - packages/handoff/src/index.ts
  - src/rooms/relay/server/handoff.ts
  - src/rooms/relay/server/service-message.ts
---

# Handoff message

TL;DR: `handoffMessage` renders a typed handoff card as instructions and a receipt template; the relay caller can deliver it and later extract a matching receipt.

## Purpose

The formatter turns a stored `HandoffCard` into the exact text that a recipient gets or that the caller passes to its subagent. Its formatter and receipt extractor are public exports from `@lane-pilot/handoff` (`packages/handoff/src/messages.ts:12-37`, `:40-55`, `packages/handoff/src/index.ts:39-48`).

## How it works

1. The caller validates create-tool input, verifies that the active PM run owns the run/project/thread, and chooses the explicitly named agent or the capability-registry match. If `toAgent` is absent and the registry has no match, it throws `no agent matches the request; name toAgent explicitly` (`src/rooms/relay/server/handoff.ts:78-85`).
2. It creates a stored handoff card with an id, project/run/thread identity, provided draft fields and optional deadline. `handoffMessage` receives the resulting typed card (`src/rooms/relay/server/handoff.ts:88-100`, `packages/handoff/src/contract.ts:43-69`).
3. The formatter builds inputs as `kind: ref` lines with optional note, or `- none` when there are no inputs. It builds the budget from truthy minute, turn and token limits plus an ISO deadline; with no parts it writes `none stated` (`packages/handoff/src/messages.ts:3-16`).
4. It joins the card heading, objective, numbered acceptance criteria, input list, budget and answer instructions in that order. The final fenced JSON block contains the handoff id, `done|blocked|rejected`, summary, outputs and evidence; the text explains when to choose blocked or rejected (`packages/handoff/src/messages.ts:17-37`).
5. If `recipientThreadId` was supplied, the caller sends the message to that BB thread. If BB rejects the sender thread as invalid, `sendServiceMessage` retries without a sender; other send failures reject. Whether sent there or returned to the caller for subagent delivery, the caller transitions the card to delivered and returns its view, selection source, destination and message (`src/rooms/relay/server/handoff.ts:100-107`, `src/rooms/relay/server/service-message.ts:19-36`).
6. When recording a receipt from output, the handler scans JSON fences through `extractHandoffReceiptBlock`, then validates the extracted object with `parseHandoffReceipt`. The extractor scans newest to oldest, matches the handoff id, removes the `handoff` field and returns the remaining JSON (`src/rooms/relay/server/handoff.ts:122-134`, `packages/handoff/src/messages.ts:40-55`, `packages/handoff/src/contract.ts:71-99`).

| Branch | Condition | Outcome or failure |
|---|---|---|
| No budget values | No truthy max minutes, turns, tokens or deadline. | Text says `none stated`; zero budget values are omitted by the formatter (`packages/handoff/src/messages.ts:3-10`). |
| No inputs | Card inputs array is empty. | Text includes `- none` (`packages/handoff/src/messages.ts:13-16`). |
| Direct-to-thread delivery | `recipientThreadId` is present. | Send failure rejects before delivered transition; a transition refusal also throws (`src/rooms/relay/server/handoff.ts:101-107`). |
| Invalid sender thread | BB's send error identifies `parent_thread_invalid` or a sender-subject rejection. | The service retries without `senderThreadId`; if that retry fails, the tool rejects (`src/rooms/relay/server/service-message.ts:19-36`). |
| Caller-mediated delivery | No recipient thread id. | Text is returned with `deliveredTo: "caller"`; caller carries it to its own subagent (`src/rooms/relay/server/handoff.ts:101-107`). |
| Receipt extraction | Output has a fenced JSON object with matching `handoff`. | Matching receipt body is returned without the id. Malformed blocks and nonmatching ids are skipped; no match returns null (`packages/handoff/src/messages.ts:40-55`). |
| Invalid or absent receipt | Caller supplied no parsed receipt and no matching extracted block, or receipt schema fails. | Handler throws a request for the JSON block or the schema error (`src/rooms/relay/server/handoff.ts:126-131`, `packages/handoff/src/contract.ts:71-99`). |

## Business rules

The input and card schemas bound title, objective, acceptance text, optional request, inputs, budget, deadline and agent ids; receipt status is restricted to `done`, `blocked` or `rejected` (`src/rooms/relay/server/handoff.ts:46-58`, `packages/handoff/src/contract.ts:31-41`, `:43-76`). The extractor chooses the last valid matching JSON fence, so an earlier matching block does not override a later one (`packages/handoff/src/messages.ts:42-53`).

## Public API or commands

`@lane-pilot/handoff` exports `handoffMessage(card: HandoffCard): string` and `extractHandoffReceiptBlock(output, handoffId): string | null` (`packages/handoff/src/index.ts:39-48`). `lane_pilot_handoff_create` creates and returns a formatted card; `lane_pilot_handoff_receipt` accepts either parsed receipt or recipient output (`src/rooms/relay/server/handoff.ts:69-78`, `:111-121`).

## Gotchas

- The formatter has no error-result branch; validation and delivery failures happen in the caller around it (`packages/handoff/src/messages.ts:12-37`, `src/rooms/relay/server/handoff.ts:78-107`).
- The extractor checks only fenced blocks labelled `json`, while receipt validation is a separate step (`packages/handoff/src/messages.ts:40-55`, `packages/handoff/src/contract.ts:97-99`).
- If a message sends successfully but the card cannot transition to delivered, the tool throws after the send; the send is not compensated in this handler (`src/rooms/relay/server/handoff.ts:101-107`).

See [RPC and host-call contracts](../rpc-callers.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [RPC and host-call contracts](../rpc-callers.md)
