---
title: Design evaluation rubric
type: component
created: 2026-10-23
updated: 2026-10-25
status: active
confidence: medium
tags: [sma, design, rubric, playwright]
sources:
  - src/rooms/design-eval/logic.ts
  - scripts/lp-design-eval.ts
---

# Design evaluation rubric

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

`measure` opens the URL in Playwright at 375 and 1280 pixel viewports, waits for `networkidle` and another four seconds, then evaluates each frame and combines the measurements by width (`scripts/lp-design-eval.ts:9-24`).

## How it works

1. `measure` opens each requested URL in a fresh browser context at 375 and 1280 pixels; it evaluates every page frame after navigation and the settling delay (`scripts/lp-design-eval.ts:9-24`).
2. The browser measurement is scored against six criteria; phone width activates the tap-target score, while desktop does not judge that criterion (`src/rooms/design-eval/logic.ts:27-37`).
3. A single URL returns the average score and per-width criterion details. Two URLs return per-width criterion changes and a winner or tie (`scripts/lp-design-eval.ts:27-37`, `src/rooms/design-eval/logic.ts:40-54`).

| Mode or failure | Behavior |
|---|---|
| One URL | Reports the score and each criterion at both widths (`scripts/lp-design-eval.ts:27-37`). |
| Two URLs | Compares measurements and reports the higher score or a tie (`src/rooms/design-eval/logic.ts:47-54`). |
| No URL | Prints usage and exits with status 1 (`scripts/lp-design-eval.ts:27-28`). |
| Frame evaluation fails | That frame is omitted from the combined measurement (`scripts/lp-design-eval.ts:17-19`). |

`scoreMeasurement` uses zero score for any horizontal overflow above one pixel, one-H1 mismatch, and desktop target measurement is not judged; the other scores scale by the count of measurements outside the rubric (`src/rooms/design-eval/logic.ts:27-37`).

First live run, the Lane Pilot page on the hub (2026-10-23): 70/100 — no overflow; at 1280 px 14 of 257 text elements under AA, 50 under
12 px and two H1 (BB's shell and the plugin's own); on the phone 16 of 17 tap targets under 44 px.
