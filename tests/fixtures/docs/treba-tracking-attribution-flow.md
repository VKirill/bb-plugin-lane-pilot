---
title: Tracking and order attribution flow
type: flow
created: 2026-10-19
updated: 2026-10-19
status: active
confidence: medium
tags:
- tracking
- visits
- attribution
sources:
- server/api/track.post.ts
- server/api/track.get.ts
- server/utils/marketing-visits.ts
- server/utils/attribution.ts
- server/utils/attribution-context.ts
- server/api/channels/analytics.get.ts
- server/api/analytics/ltv.get.ts
---

# Tracking and order attribution flow

TL;DR: Public tracking writes visitor events and rebuilds that browser's marketing visits; report queries then resolve an order's channel from captured and fallback evidence under a request-local attribution model.

## Trigger

A browser sends a public GET pixel or POST event to the tracker. An authenticated report request reads channel or LTV data and may specify the `standard` or `last_paid_30d` model (`server/api/track.get.ts:61-63`, `server/api/track.post.ts:57-75`, `server/utils/attribution-context.ts:7-10`, `server/api/channels/analytics.get.ts:15`, `server/api/analytics/ltv.get.ts:14`).

## How it works

1. **Tracker API — validate and classify input.** GET reads query parameters; POST parses JSON or `text/plain`, requires a bounded visitor UID, and gives `yclid` priority over UTM by normalizing it to Yandex CPC (`server/api/track.get.ts:61-88`, `server/api/track.post.ts:57-89`).
2. **Tracker API — write observations.** Both handlers upsert the visitor and insert a `visitor_events` row. A pageview additionally classifies and inserts a `visitor_touches` row; the tracker paths then call `refreshMarketingVisits()` (`server/api/track.get.ts:91-132`, `server/api/track.post.ts:108-153`).
3. **Marketing visit utility — rebuild one browser's projection.** `buildMarketingVisits()` orders valid events by visitor, timestamp, then ID; inactive events can link to an unexpired visit, while active events start a new visit when expired or when source/ad changes. Direct activity within the visit TTL inherits the current visit (`server/utils/marketing-visits.ts:201-255`).
4. **Marketing visit utility — commit derived rows.** The refresher opens a transaction, locks visitor UIDs in sorted order, rewrites visits and event links, and commits. Errors roll back and propagate to the handler (`server/utils/marketing-visits.ts:412-434`).
5. **Report API — resolve each order.** Channel and LTV handlers build report queries using attribution SQL and the selected projection views; attribution checks stored/project-specific evidence, marketing visits, legacy touches, Metrica, order/visitor tags, prior tagged orders, then `direct` (`server/utils/attribution.ts:203-247`, `server/api/channels/analytics.get.ts:15-20`, `server/api/analytics/ltv.get.ts:14-20`).

| Mode or state | Inputs and result | Evidence |
|---|---|---|
| Tracker GET | Valid UID writes event data and returns a pixel; missing or invalid UID returns a pixel without a write. | `server/api/track.get.ts:61-63`, `server/api/track.get.ts:91-114`, `server/api/track.get.ts:137-140` |
| Tracker POST | Valid JSON/body and UID writes data and returns `{ ok: true }`; invalid body or UID returns `{ ok: false }`. | `server/api/track.post.ts:57-69`, `server/api/track.post.ts:155-159` |
| `standard` report | Uses the standard attribution projection and visit/fallback cascade. | `server/utils/attribution-context.ts:4-10`, `server/utils/attribution-context.ts:45-46` |
| `last_paid_30d` report | Uses the paid-click projection; omitted model defaults to this value. | `server/utils/attribution-context.ts:4-10`, `server/utils/attribution-context.ts:45-46` |

## Failures and compensation

Invalid POST JSON is treated as an absent body; missing/invalid UIDs are rejected without writes. A tracker database failure is logged and POST returns `{ ok: false }`; GET logs the failure and still returns the pixel. Touch insertion errors are caught locally. Visit refresh errors are logged by each handler; the refresh transaction rolls back so partial visit/link replacement is not committed (`server/api/track.post.ts:59-69`, `server/api/track.post.ts:146-158`, `server/api/track.get.ts:128-137`, `server/utils/marketing-visits.ts:419-433`).

An invalid requested attribution model produces HTTP 400. If no SQL attribution arm matches, the channel result is `direct` (`server/utils/attribution-context.ts:7-10`, `server/utils/attribution.ts:214-247`).

## Modes

Tracker GET and POST share visitor/event persistence but differ in transport and invalid-input response. Order reports select one of two projection models; both are request-local, so concurrent requests do not overwrite each other's choice (`server/api/track.get.ts:61-63`, `server/api/track.post.ts:57-69`, `server/utils/attribution-context.ts:17-28`).

## Related pages

- [Tracking and order attribution](../components/tracking-attribution.md)
- [Channel attribution SQL](../components/cluster-87.md)
