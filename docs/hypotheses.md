---
title: Hypotheses checked on the bench
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, hypotheses, bench, rhi]
sources:
  - src/rooms/hypotheses/server/hypotheses.ts
  - src/rooms/hypotheses/brief-mode.ts
---

# Hypotheses checked on the bench (SMA P2-10, P2-11)

An idea to make the system better — from outside (a repository, a post, a talk) or from inside — is written as the settings that carry it
and checked on the frozen bench set:

```bash
bb lane-pilot hypothesis add --title "…" --source <url> --setting key=value
bb lane-pilot hypothesis test <id> [--set vN] [--tasks N]   # baseline arm hyp-<id>-base and the idea's arm hyp-<id>
bb lane-pilot hypothesis verdict <id>                        # bench compare: worse → rejected
bb lane-pilot hypothesis revert <id>                         # an adopted one: the old global values back
```

Not worse on the bench → the change goes to the night policy as a `setting_change` with the bench proof (policy v4 `bench_proven_setting`):
the night applies it at the global level (adopted, undone by writing the old values back); a change the policy keeps off the night — a model,
a provider, a budget — stays held, never applied.

**Seeded: contracts between roles (P2-11, RHI).** `writer.brief_mode=narrow`: the writer gets its role, the contract, the plan and the task
folder only — no memory notes, no rules, no PM read summary — against today's full brief. The hypothesis `role-contracts` is on the register
from the first start; `hypothesis test role-contracts` runs it on the newest set.
