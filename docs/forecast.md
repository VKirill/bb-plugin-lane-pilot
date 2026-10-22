---
title: Plan forecast and calibration
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, forecast, calibration, pm]
sources:
  - src/rooms/forecast/logic.ts
  - src/rooms/forecast/server/report.ts
---

# Plan forecast and calibration (SMA D2-1)

Before dispatch the PM may write a forecast in the task contract:

```json
"forecast": { "files": 2, "checks_pass_first_try": true, "tokens": 150000, "minutes": 25 }
```

The writer never sees it (`compactContract`). After acceptance the code compares it with what is on record — the files the accepted
attempt changed (`lane_pilot_attempt_change`), whether it was the first attempt, its tokens and minutes (attempt metrics; not measured
stays null, never 0) — and sums the errors per area (`calibrate`): mean absolute file error and bias, the share of «first try» forecasts
that came true, the median fact/forecast ratio of tokens and minutes.

- `bb lane-pilot forecast [--project P] [--days 30] [--json]`, RPC `forecast_report`.
- The PM reads one calibration line with the register of deferrals before it promises a date (SMA rule 6), once three tasks are scored.

Pure parts (`scoreForecast`, `calibrate`, `calibrationLine`) are in `src/rooms/forecast/logic.ts`; the reading of the facts in `server/report.ts`.
