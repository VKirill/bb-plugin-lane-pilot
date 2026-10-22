---
title: Design evaluation rubric
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, design, rubric, playwright]
sources:
  - src/rooms/design-eval/logic.ts
  - scripts/lp-design-eval.ts
---

# Design evaluation (SMA D2-12)

A design-lead result or a change of a design skill is scored by code on the real page, not by a model's taste. The rubric is what a
browser can measure, at 375 and 1280 px, in every frame of the page (a BB plugin page is a frame):

| criterion | measured |
|---|---|
| overflow | no horizontal scroll |
| contrast | text elements under WCAG AA (4.5, or 3 for large text), colours converted by the browser (oklch included) |
| targets | interactive elements under 44 px on a phone |
| tiny_text | text under 12 px |
| one_h1 | exactly one H1 |
| spacing | at most 12 distinct margin/padding/gap values |

```bash
npx tsx scripts/lp-design-eval.ts <url>            # score 0..100 and each criterion with what was measured
npx tsx scripts/lp-design-eval.ts <url-a> <url-b>  # paired judgement: the better version and what changed
```

First live run, the Lane Pilot page on the hub (2026-10-23): 70/100 — no overflow; at 1280 px 14 of 257 text elements under AA, 50 under
12 px and two H1 (BB's shell and the plugin's own); on the phone 16 of 17 tap targets under 44 px.
