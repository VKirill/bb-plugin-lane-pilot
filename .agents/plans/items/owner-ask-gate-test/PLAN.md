# Update the stale owner-ask gate test after «gate never asks the owner»

Commit 5a000d0 (2026-10-09, «fix: a red integration gate never asks the owner; the PM is told to investigate and fix») changed `IntegrationGateRunner.tellPm` in src/rooms/verification/server/integration-gate.ts. It now only sends a message to the PM thread through `bb.sdk.threads.send`, with ANSI codes stripped, and never opens an owner form. That commit updated tests/verification/integration-gate-episode.test.ts but not tests/owner-ask.test.ts.

The `describe("the integration gate asks the owner when no culprit can be named (H8)")` block there still expects:
- `pendingInteractions` to have length 1;
- an answer to be forwarded.

The deploy gate fails on it consistently:

```
expected [] to have a length of 1 but got +0
tests/owner-ask.test.ts:179
```

The behaviour is intended: the owner explicitly does not want the gate asking him. Fix the test, not the code:
- Rewrite that describe block so that a red gate's `tellPm` opens no interaction (`pendingInteractions` is empty).
- The PM thread gets exactly one message with the text and ANSI colour codes stripped. Include an ANSI sequence in the input.
- Remove assertions about forwarding the owner's answer and about the ownerAsk being unavailable, because the gate no longer uses ownerAsk.
- Keep the other describe blocks of tests/owner-ask.test.ts (lane_pilot_ask_owner tool) unchanged.

## Delivery
- [x] Updated the gate regression test for PM messaging without opening an owner interaction — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `68a7856`.
