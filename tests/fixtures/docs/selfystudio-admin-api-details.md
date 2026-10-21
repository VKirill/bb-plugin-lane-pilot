---
title: SelfyStudio Admin API Operation Details
type: component
created: 2026-10-21
updated: 2026-10-21
status: active
confidence: medium
tags: [api, admin, routes]
sources:
  - apps/api/src/routes/v1/admin/alerts/rules/routes.ts
  - apps/api/src/routes/v1/admin/alerts/rules/schemas.ts
  - apps/api/src/routes/v1/admin/alerts/rules/dto.ts
  - apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts
  - apps/api/src/routes/v1/admin/ai-models/route-support.ts
  - apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts
  - apps/api/src/routes/v1/seo-clusters-marker.ts
  - apps/api/src/routes/v1/admin/catalog/handlers.ts
  - apps/api/src/routes/v1/admin/catalog/service.ts
  - apps/api/src/routes/v1/admin/catalog/routes.ts
  - apps/api/src/routes/v1/admin/articles/ingest.ts
  - apps/api/src/routes/v1/admin/articles/ingest-service.ts
  - apps/api/src/composition/pg-admin-db.ts
  - apps/api/src/routes/v1/admin/greeting-cards/funnel.ts
  - apps/api/src/routes/v1/admin/greeting-cards/offer-arm-labels.ts
---

# SelfyStudio Admin API Operation Details

TL;DR: This page explains alert rules, AI-model CRUD, SEO-cocoon graph routes, catalog listing, content-factory ingestion, and greeting-card funnel/readout behavior.

## Purpose

The [Admin API route reference](admin-api.md) owns the route index and access overview. This page owns the branch behavior and failure outcomes for the operations linked from that index.

## Alert routing rules

### How it works

1. Every route authenticates a request and then checks for role `admin` plus the scope required by the operation. Reads require `admin:read`; create, update, delete and test require `admin:write`. Writes also enable idempotency (`apps/api/src/routes/v1/admin/alerts/rules/routes.ts:37-57`, `:69-84`, `:113-128`, `:183-200`, `:267-283`, `:325-342`).
2. `GET /v1/admin/alerts/rules` selects the newest 500 rows and returns DTOs with private no-store caching. `GET /:id` returns one DTO or 404 (`apps/api/src/routes/v1/admin/alerts/rules/routes.ts:38-67`, `:69-99`).
3. `POST /v1/admin/alerts/rules` validates `name`, optional description, source (`sentry`, `grafana`, `manual`), severity (`p1`, `p2`, `p3`), optional title pattern and channel UUID, cooldown and enabled state. It defaults omitted cooldown to 300 seconds and `isEnabled` to true, then inserts and audits in one transaction; a valid actor UUID becomes `createdBy` (`apps/api/src/routes/v1/admin/alerts/rules/schemas.ts:1-72`, `apps/api/src/routes/v1/admin/alerts/rules/routes.ts:125-168`).
4. `PUT /:id` applies only supplied fields. An empty patch returns 400; otherwise update and changed-key audit share a transaction. `DELETE /:id` removes the row and writes `alert.rule_deleted` in the same transaction, then returns 204 (`apps/api/src/routes/v1/admin/alerts/rules/routes.ts:197-264`, `:280-313`).
5. `POST /:id/test` reads the rule and enabled channel, writes an audit-only test event, and returns `{ok, channelKind, summary}`. It does not create an alert or send channel traffic; `ok` is false when no enabled channel is assigned (`apps/api/src/routes/v1/admin/alerts/rules/routes.ts:325-398`).

### Modes

| Operation | Result | Evidence |
|---|---|---|
| List / detail | Newest 500 rules / one rule; absent detail is 404. | `apps/api/src/routes/v1/admin/alerts/rules/routes.ts:37-99` |
| Create | Defaults cooldown to 300 seconds and enabled to true; create plus audit are atomic. | `apps/api/src/routes/v1/admin/alerts/rules/routes.ts:125-168` |
| Partial update | Only supplied fields are changed; empty update is rejected. | `apps/api/src/routes/v1/admin/alerts/rules/routes.ts:203-263` |
| Delete | Deletes row and records deletion audit in one transaction. | `apps/api/src/routes/v1/admin/alerts/rules/routes.ts:292-313` |
| Test | Audit-only synthetic check; does not dispatch an alert. | `apps/api/src/routes/v1/admin/alerts/rules/routes.ts:325-398` |

### Failures

Authentication/scope failures return 401/403; missing detail, delete or test target returns 404; invalid schema or an empty update returns 400. Insert, update, delete and audit operations use transactions, so an audit failure rolls back the corresponding mutation (`apps/api/src/routes/v1/admin/alerts/rules/routes.ts:37-57`, `:90-98`, `:228-263`, `:292-313`, `:350-355`; `apps/api/src/routes/v1/admin/alerts/rules/schemas.ts:59-87`).

## AI model catalog

### How it works

1. `GET /v1/admin/ai-models` requires admin read scope, returns models sorted active-first then routing weight and key, plus vendor-locked modes. It joins the 7-day metrics view; if that relation is missing it retries without the join and returns null metrics (`apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:24-79`, `:81-109`).
2. `POST /v1/admin/ai-models` requires write scope and idempotency, rejects a duplicate key with 409, and inserts the model and create audit atomically. Defaults are routing weight 0, status `active`, no cost/quality/tariff, unlocked vendor and empty config; after commit it publishes an update and returns 201 (`apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:116-227`).
3. `PUT /:key` maps only supplied fields into a partial update. A no-field patch returns 400 and an unknown key returns 404. The before snapshot, update and audit events share a transaction; weight/status changes and changed image cost require an audit reason of at least 10 characters. After commit it publishes the update and returns 200 (`apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:234-277`, `:303-421`, `:423-477`).
4. `DELETE /:key` is a soft archive that sets status to `deprecated`, audits in the transaction, then publishes the archived event; missing keys return 404 (`apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:480-548`).

### Modes

| Operation | Branch and result | Evidence |
|---|---|---|
| List | Metrics view available: include 7-day metrics; missing view: retry with null metric columns. | `apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:48-79` |
| Create | Duplicate `key` returns 409; successful insert plus audit returns 201. | `apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:161-227` |
| Update | Empty patch 400, absent key 404, successful partial patch 200; routing/status or price changes require a reason. | `apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:303-421` |
| Archive | Soft-sets `deprecated`; does not physically delete the model. | `apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:483-548` |

### Failures

Missing role/scope and idempotency key reject writes before mutation. Duplicate model key is 409; missing update/archive target is 404; empty update is 400; routing/status or cost changes without a 10-character `X-Reason` fail with 422. Transactional audit failure rolls back the DB mutation; post-commit pubsub errors occur after persisted state (`apps/api/src/routes/v1/admin/ai-models/ai-models-crud.routes.ts:152-174`, `:319-405`, `:437-455`, `:514-548`).

## SEO cocoon cluster routes

### How it works

1. `PUT /v1/admin/seo-clusters/upsert` validates the request schema, then requires admin role, write scope, idempotency key and actor. It resolves the group, optionally attaches an existing published cluster by match keys, creates placeholder parents/targets as needed, and upserts keywords and graph edges. `preserve_existing` keeps current cluster fields and adds only missing keywords/links; a matched or already-published cluster freezes incoming status/URL changes. The cluster writes and audit event share a transaction (`apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:440-467`; `apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:262-392`).
2. `POST /v1/admin/seo-clusters/import-yaml` parses all YAML documents, accepts each document as a cluster or a list of clusters, applies import defaults, then upserts every entry in one transaction. It returns counts for created, updated, links and attached targets and writes one import audit event (`apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:469-505`; `apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:118-163`).
3. The registrar installs page-status routes: `PUT /page-status` finds a non-merged cluster by slug, then target URL, then landing marker; it updates the writable status and URL and audits in one transaction. `POST /sync-published` scans published shoot landings, marks matched non-excluded clusters published, and reports unmatched or ambiguous landings (`apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:509`; `apps/api/src/routes/v1/seo-clusters-marker.ts:198-234`, `:246-297`, `:306-377`).
4. `GET /:id/links` requires read scope, returns outgoing and incoming edges, and returns 404 for an unknown cluster (`apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:511-552`).

### Modes

| Route | Contract | Evidence |
|---|---|---|
| `PUT /v1/admin/seo-clusters/upsert` | Upsert one validated cluster and its graph edges. | `apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:440-467` |
| `POST /v1/admin/seo-clusters/import-yaml` | YAML documents or lists; malformed entries fail validation; import returns aggregate counts. | `apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:118-163`, `:469-505` |
| `preserve_existing` / published-match branch | Preserve existing fields and append missing graph entries; matched or published rows retain their page status and target URL. | `apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:262-335`, `:337-392` |
| `GET /v1/admin/seo-clusters/:id/links` | Read both graph directions; missing cluster is 404. | `apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:511-552` |
| `PUT /v1/admin/seo-clusters/page-status` | Write one of `planned`, `draft`, `published` or `excluded` for a `shoot` or `article` target. Slug lookup precedes URL and marker lookup. | `apps/api/src/routes/v1/seo-clusters-marker.ts:8-10`, `:198-234`, `:306-349` |
| `POST /v1/admin/seo-clusters/sync-published` | Backfill published shoot landing status; unmatched and ambiguous landing rows are returned in the summary. | `apps/api/src/routes/v1/seo-clusters-marker.ts:263-297`, `:351-377` |

### Failures

Malformed bodies, unsupported groups/statuses or invalid graph references return 400; missing role/scope returns 403; missing cluster on page-status update or link read returns 404. Ambiguous page-status lookup returns 409. The sync route skips excluded clusters and reports not-found or ambiguous matches instead of aborting the batch. Upsert/import audit and data writes share their transaction; validation or audit errors prevent partial import commits (`apps/api/src/routes/v1/admin-seo-clusters-cocoon.routes.ts:440-505`, `:511-549`; `apps/api/src/routes/v1/seo-clusters-marker.ts:198-234`, `:246-297`, `:306-377`).

## Catalog listing

### How it works

`listCatalogHandler` applies the admin read guard, clamps `limit` to 1–500 (default 200), parses the `sortIndex:id` cursor, trims search, and accepts category, active-state and `style|prompt|all` template filters. It reads through the admin cache, requests one extra row to determine `nextCursor`, maps rows to DTOs and returns private no-store data. A missing `catalog_styles` relation is an empty list; other database errors propagate (`apps/api/src/routes/v1/admin/catalog/handlers.ts:63-102`, `apps/api/src/routes/v1/admin/catalog/service.ts:31-79`).

| Branch | Result | Evidence |
|---|---|---|
| `templateType` is `style` or `prompt` | Exact template filter. | `apps/api/src/routes/v1/admin/catalog/handlers.ts:79-82`, `apps/api/src/routes/v1/admin/catalog/service.ts:35-64` |
| `templateType` absent, `all`, or invalid | No template filter. | `apps/api/src/routes/v1/admin/catalog/handlers.ts:79-82`, `apps/api/src/routes/v1/admin/catalog/service.ts:35-64` |
| Catalog table missing | Empty page with null cursor. | `apps/api/src/routes/v1/admin/catalog/service.ts:37-79` |
| Other database error | Propagates to API error handling. | `apps/api/src/routes/v1/admin/catalog/service.ts:37-69` |

## Content-factory article ingestion

#### Content-factory article ingestion

`adminArticlesIngestRoutes` registers three authenticated modes: `GET /v1/admin/articles/taxonomy` for read-scoped discovery, `POST /v1/admin/articles/ingest` for a write-scoped upsert, and `POST /v1/admin/articles/ingest-image` for a write-scoped image import. The handlers derive the actor and trace context from the authenticated request; scopes come from the server-side admin role (`apps/api/src/routes/v1/admin/articles/ingest.ts:18-35`, `:151-180`, `:220-237`).

1. Taxonomy reads categories ordered by depth/sort/name, all tags, and active locales. Each query treats PostgreSQL missing-relation error `42P01` as an empty list; other database errors propagate. The response is `200` with `Cache-Control: private, no-store` (`apps/api/src/routes/v1/admin/articles/ingest-service.ts:29-40`, `:43-80`; `apps/api/src/routes/v1/admin/articles/ingest.ts:152-166`).
2. Article ingest requires `external_ref`, `slug`, `title` and `body_md`; the schema also bounds metadata, tags, category fields and scenes. `status` selects `published` only when explicitly set to that value; otherwise the service uses `draft`. Before opening the article transaction it validates a supplied `cover_media_id`, or attempts to fetch and store `cover_image_url`; an image-import failure is non-fatal and the article proceeds without a newly resolved cover (`apps/api/src/routes/v1/admin/articles/ingest.ts:87-136`, `:179-186`; `apps/api/src/routes/v1/admin/articles/ingest-service.ts:289-314`).
3. Inside one transaction the service resolves an optional `seo-cluster:<uuid>` reference, looks up the article by `external_ref`, and checks whether another article owns the requested slug. Existing articles are updated in place; new references insert a row. On insert, `categorySlug` takes precedence over the legacy `category`; on update, only a non-empty `categorySlug` changes the category. Tag links are deleted and rebuilt from the request; missing tags are inserted, while an existing tag slug is reused. The primary category link and audit row are written in the same transaction as the article (`apps/api/src/routes/v1/admin/articles/ingest-service.ts:314-345`, `:388-445`, `:243-280`, `:435-445`).
4. Scenes, when supplied, are limited to 40 and validated for unique positive numbers, HTTPS image/selfie URLs, `people` mode, and one selfie for `male`/`female` or two for `pair`; they are sorted by scene number before storage. Slug collision returns 409; invalid category, cover-media UUID or scene data returns 400; an absent persisted row returns 500. A thrown error in the transaction rolls back the article, tag/category links and audit write together (`apps/api/src/routes/v1/admin/articles/ingest-service.ts:185-223`, `:226-240`, `:314-316`, `:435-445`; `apps/api/src/composition/pg-admin-db.ts:112-140`).
5. A created row returns 201 and an update returns 200. Draft results return directly without recrawl submissions. Published results trigger best-effort IndexNow notification and a Yandex Webmaster submission; notification errors are logged/swallowed, and a thrown recrawl submission is returned as `webmaster: { status: 'error', body: 'submit_failed' }` without undoing the article write (`apps/api/src/routes/v1/admin/articles/ingest.ts:187-212`).
6. The image-import mode accepts an HTTPS source, fetches at most 10 MiB with a 15-second timeout and up to five redirects, allows JPEG/PNG/WebP, then forwards bytes through `/v1/admin/media/upload`. It returns the stored media ID and URL with 201; fetch, media-pipeline, response-ID or public-URL failure becomes 422. The same helper is used for article cover URLs (`apps/api/src/routes/v1/admin/articles/ingest.ts:220-246`; `apps/api/src/routes/v1/admin/articles/ingest-service.ts:470-548`).

| Branch | Outcome | Evidence |
|---|---|---|
| Taxonomy relation missing | That taxonomy list is empty; other query errors propagate. | `apps/api/src/routes/v1/admin/articles/ingest-service.ts:29-40`, `:43-79` |
| Existing `external_ref` | Update that row; return 200. | `apps/api/src/routes/v1/admin/articles/ingest-service.ts:318-388`; `apps/api/src/routes/v1/admin/articles/ingest.ts:187-188` |
| New `external_ref` | Insert row; return 201. | `apps/api/src/routes/v1/admin/articles/ingest-service.ts:388-425`; `apps/api/src/routes/v1/admin/articles/ingest.ts:187-188` |
| Slug belongs to another reference | Roll back and return 409. | `apps/api/src/routes/v1/admin/articles/ingest-service.ts:323-331`; `apps/api/src/composition/pg-admin-db.ts:112-140` |
| Bad category or scene data | Roll back and return 400. | `apps/api/src/routes/v1/admin/articles/ingest-service.ts:185-223`, `:226-240`; `apps/api/src/composition/pg-admin-db.ts:112-140` |
| Cover URL cannot be imported during article ingest | Continue the upsert without a newly resolved cover. | `apps/api/src/routes/v1/admin/articles/ingest-service.ts:297-307`, `:473-548` |
| Image-import endpoint cannot fetch/store a valid image | Return 422. | `apps/api/src/routes/v1/admin/articles/ingest.ts:230-245`; `apps/api/src/routes/v1/admin/articles/ingest-service.ts:478-548` |

## Greeting-card funnel and recent runs

`GET /v1/admin/greeting-cards/funnel` accepts `days` from 1 through 365 (default 30) and counts visits, starts, completed previews, checkout opens, accounts, paid runs and cabinet owners by marketing channel. It excludes admin-test and prepaid-user runs; runs without the `sf_vid` visit link are grouped as `unknown` (`apps/api/src/routes/v1/admin/greeting-cards/funnel.ts:13-47`, `:81-94`).

`GET /v1/admin/greeting-cards/runs` returns the newest 40 card runs with page/design, status/error, offer arm, outcome, purchase and a one-hour signed preview only for completed runs. Test and prepaid markers are included. Outcome and purchase labels branch on failed/completed state, payment/refund status, product, pricing mode and preview mode (`apps/api/src/routes/v1/admin/greeting-cards/funnel.ts:58-76`, `:96-135`; `apps/api/src/routes/v1/admin/greeting-cards/offer-arm-labels.ts:1-69`).

A run outcome can be generation error, payment opened, waiting behind a blurred/prepay preview, preview shown, or an empty marker. A purchase is labeled only for succeeded public-card/tab orders; admin-test orders are marked test and refunded succeeded orders are marked refunded (`apps/api/src/routes/v1/admin/greeting-cards/offer-arm-labels.ts:13-69`). Both reads require admin read scope and return private no-store data (`apps/api/src/routes/v1/admin/greeting-cards/funnel.ts:81-105`, `:134`).
