---
title: SelfyStudio operator capabilities
type: capabilities
created: 2026-10-01
updated: 2026-10-21
status: active
confidence: high
tags: [capabilities, operators, admin]
sources:
  - apps/admin/plugins/payments/manifest.ts
  - apps/api/src/middleware/require-admin-scope.ts
  - apps/api/src/routes/v1/admin/onboarding/routes.ts
  - apps/api/src/routes/v1/admin/onboarding/handlers.ts
  - apps/api/src/routes/v1/admin/analytics/handlers.ts
  - apps/api/src/routes/v1/admin/analytics/service.ts
  - apps/api/src/routes/v1/admin/onboarding/service.ts
  - apps/admin/app/layouts/admin.vue
  - apps/admin/plugins/_shared/discoverPlugins.ts
  - apps/admin/plugins/dashboard/manifest.ts
  - apps/admin/plugins/statistics/manifest.ts
  - apps/admin/plugins/trends/manifest.ts
  - apps/admin/plugins/photosets/manifest.ts
  - apps/admin/plugins/photosets/components/PhotosetFolderPhotos.vue
  - apps/api/src/routes/v1/admin/catalog/photos/routes.ts
  - apps/api/src/routes/v1/admin/catalog/photos/handlers.ts
  - apps/api/src/routes/v1/public-cards/generate.ts
  - apps/api/src/routes/v1/public-cards-checkout/test-unlock.ts
  - apps/api/src/routes/v1/public-cards-checkout/constants.ts
  - apps/marketing/app/components/greeting-cards/CardGenerator.vue
  - apps/admin/plugins/messages/manifest.ts
  - apps/admin/plugins/vk-campaigns/manifest.ts
  - apps/admin/plugins/settings/manifest.ts
  - apps/admin/plugins/feature-flags/manifest.ts
  - apps/admin/plugins/articles/manifest.ts
  - apps/admin/plugins/article-writer/manifest.ts
  - apps/api/src/routes/v1/admin/articles/handlers.ts
  - apps/api/src/routes/v1/admin/articles/ingest.ts
  - apps/admin/plugins/marketing/manifest.ts
  - apps/admin/plugins/marketing/components/SpendForm.vue
  - apps/admin/plugins/media/manifest.ts
  - apps/admin/plugins/pages/manifest.ts
  - apps/admin/plugins/docs-photo/manifest.ts
  - apps/admin/plugins/alerts/manifest.ts
  - apps/admin/plugins/moderation/manifest.ts
  - apps/admin/plugins/hide-requests/manifest.ts
  - apps/admin/plugins/scenarios/manifest.ts
  - apps/admin/plugins/sandbox/manifest.ts
  - apps/scenario-runner/src/main.ts
  - apps/admin/plugins/seo-clusters/manifest.ts
  - apps/admin/plugins/seo-landings/manifest.ts
  - apps/api/src/routes/v1/admin-seo-clusters-crud.routes.ts
  - apps/api/src/routes/v1/admin-seo-clusters-list.routes.ts
  - apps/api/src/routes/v1/admin/users/users-timeline.routes.ts
  - apps/api/src/routes/v1/admin/scenarios/cluster-source.routes.ts
  - apps/api/src/routes/v1/admin/scenarios/autopilot.ts
  - apps/api/src/routes/v1/admin/scenarios/card-page-source.ts
  - apps/api/src/lib/seo-links-jev.ts
  - packages/infrastructure/persistence-prisma/prisma/migrations/20261011090000_scenario_autopilot_daily_limit_5000/migration.sql
  - apps/admin/plugins/seo-clusters/components/SeoClustersClusterList.vue
  - apps/admin/plugins/seo-clusters/components/SeoClustersEvidenceBlock.vue
  - apps/admin/plugins/seo-clusters/components/SeoClustersEvidenceVerdict.vue
  - apps/admin/plugins/seo-clusters/composables/useSeoClustersEvidenceBlock.ts
  - apps/admin/plugins/scenarios/components/ScenarioClusterSource.vue
  - apps/api/src/routes/v1/admin/seo-landings/seo-landings.routes.ts
  - apps/admin/nuxt.config.ts
  - docker-compose.yml
  - apps/api/src/routes/v1/admin/index.ts
  - apps/api/src/server.ts
  - apps/vk-bot/src/auto-publisher.ts
  - apps/vk-bot/src/pipeline.ts
  - apps/scenario-runner/src/executors/index.ts
  - apps/scenario-runner/src/executors/assemble/assemble-executor.ts
  - apps/scenario-runner/src/executors/cocoon-write/cocoon-write-executor.ts
  - apps/scenario-runner/src/executors/published-pages/published-pages-executor.ts
  - apps/scenario-runner/src/cli-registry/task.ts
  - apps/worker/src/lib/agent-runner-broker.ts
  - apps/worker/src/main.ts
  - apps/worker/src/sagas/process-generation-job.ts
  - apps/worker/src/jobs/provider-capacity-report.ts
  - database-audit/run.sh
  - database-audit/validators/preflight.py
  - apps/worker/src/sagas/process-generation-notify.ts
  - apps/admin/plugins/onboarding/manifest.ts
  - apps/admin/plugins/greeting-cards/manifest.ts
  - apps/admin/plugins/greeting-cards/pages/index.vue
  - apps/admin/plugins/greeting-cards/pages/stats.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardPagePanel.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardContentTab.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardDesignsTab.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardMetaPromptEditor.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardMetaPromptTest.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardAiDesigns.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardTree.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardToolPanel.vue
  - apps/api/src/routes/v1/admin/greeting-cards/routes.ts
  - apps/api/src/routes/v1/admin/greeting-cards/stats.ts
  - apps/api/src/routes/v1/admin/greeting-cards/funnel.ts
  - apps/api/src/routes/v1/admin/greeting-cards/page-content.ts
  - apps/api/src/routes/v1/admin/greeting-cards/ai-designs.ts
  - apps/admin/plugins/greeting-cards/components/GreetingCardRecentRuns.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardFunnel.vue
  - apps/admin/plugins/greeting-cards/components/GreetingCardStyles.vue
  - apps/api/src/routes/v1/admin/greeting-cards/card-styles-routes.ts
  - apps/api/src/routes/v1/admin/greeting-cards/card-styles.ts
  - apps/api/src/routes/v1/admin/greeting-cards/spend-cap.ts
  - apps/api/src/routes/v1/admin/articles/routes.ts
  - apps/api/src/routes/v1/admin/catalog/handlers.ts
  - apps/api/src/routes/v1/admin/executors/routes.ts
  - apps/api/src/main.ts
  - apps/admin/plugins/media-origins/manifest.ts
  - apps/admin/plugins/media-origins/pages/index.vue
  - apps/admin/server/api/admin/media-origins.get.ts
  - apps/api/src/routes/v1/admin/media-probe/routes.ts
  - apps/api/src/routes/v1/admin/localization/routes.ts
  - apps/api/src/routes/v1/admin/localization/service.ts
  - apps/api/src/routes/v1/admin/localization/constants.ts
  - apps/api/src/routes/v1/public-media-probe.ts
  - apps/api/src/lib/media-probe-origins.ts
  - apps/admin/plugins/seo-landings/components/shoot-content-v2.ts
  - apps/admin/plugins/seo-landings/pages/[id].vue
  - apps/admin/plugins/site-tools/manifest.ts
  - apps/admin/plugins/site-tools/components/SiteToolsHubCatalogPanel.vue
  - apps/admin/plugins/site-tools/components/SiteToolsV2PageCopyEditor.vue
---

# SelfyStudio operator capabilities

TL;DR: This page lists the operator and service actions implemented across Admin, API, workers and operational tools.

Sticker-pack reporting is listed in [sticker pack capabilities](stickers.md#operator-reporting).

### Operator and service capabilities

| Capability | Availability and conditions | Details |
|---|---|---|
| Review user/payment records; manage tariffs, promo codes, referral payouts, generation economics, and profile selection. | Admin screens; billing/security writes require matching API scope (`apps/admin/plugins/payments/manifest.ts:1-34`, `apps/api/src/middleware/require-admin-scope.ts:17-29`). | [Accounts and finance](../../apps/admin/docs/features/accounts-finance.md) |
| Exercise the public greeting-card preview and paid-order test path. | A test pass enables the `step=2` and `step=3` shortcuts; the API creates an immediate preview from an approved example only for the test name `Кирилл_тест`. A separate test-unlock endpoint marks admin-priced orders paid without a provider payment and does not grant the first-payment bonus (`apps/marketing/app/components/greeting-cards/CardGenerator.vue:63,80-89,169-173`, `apps/api/src/routes/v1/public-cards/generate.ts:93-115,180-200,261-282`, `apps/api/src/routes/v1/public-cards-checkout/test-unlock.ts:32-80`, `apps/api/src/routes/v1/public-cards-checkout/constants.ts:4-15`). | [Greeting-card tools](../features/public-tools.md), [greeting-card delivery](../flows/media/greeting-card-delivery.md) |
| Manage greeting-card pages, designs and delivery economics; review performance. | `/admin/greeting-cards` provides a searchable, status-filtered page tree and page/tool workspace. Operators can run and review page-content generation, save or restore design prompt versions, edit and test the story meta-prompt, generate one to ten designs per request (new page content starts five by default, and rejected designs are topped up), publish pages or the tool, fill design tags, enable or disable the twelve styles offered for random-design cards, and set the daily spend cap (`apps/admin/plugins/greeting-cards/manifest.ts:9-19`, `apps/admin/plugins/greeting-cards/pages/index.vue:73-99`, `apps/admin/plugins/greeting-cards/components/GreetingCardTree.vue:21-26,86-104`, `apps/admin/plugins/greeting-cards/components/GreetingCardPagePanel.vue:17-19,157-178`, `apps/admin/plugins/greeting-cards/components/GreetingCardContentTab.vue:8-10,47-57,69-97`, `apps/admin/plugins/greeting-cards/components/GreetingCardDesignsTab.vue:43-59,87-100,128-143`, `apps/admin/plugins/greeting-cards/components/GreetingCardToolPanel.vue:3,13-14,41-64,102-150`, `apps/admin/plugins/greeting-cards/components/GreetingCardStyles.vue:5-6,13-31`, `apps/admin/plugins/greeting-cards/components/GreetingCardMetaPromptEditor.vue:23-32,57-85`, `apps/admin/plugins/greeting-cards/components/GreetingCardMetaPromptTest.vue:13,43-49`, `apps/admin/plugins/greeting-cards/components/GreetingCardAiDesigns.vue:8,53-69,88-112`, `apps/api/src/routes/v1/admin/greeting-cards/routes.ts:17-32`, `apps/api/src/routes/v1/admin/greeting-cards/page-content.ts:20-22,85-89`, `apps/api/src/routes/v1/admin/greeting-cards/ai-designs.ts:94-116,205-225,242-271,310-334`, `apps/api/src/routes/v1/admin/greeting-cards/card-styles-routes.ts:15-40`, `apps/api/src/routes/v1/admin/greeting-cards/card-styles.ts:21-34`, `apps/api/src/routes/v1/admin/greeting-cards/spend-cap.ts:10-74`). `/admin/greeting-cards/stats` offers period-based sales, generation, spend, payment, revenue, conversion and refund reporting, provider totals, up to 50 recent orders with masked email, the 40 latest generation runs with offer-arm and purchase/payment outcomes, a per-arm preview-to-checkout funnel, and a traffic-channel funnel from visit through cabinet sign-in (`apps/admin/plugins/greeting-cards/pages/stats.vue:55-64,87-140`, `apps/admin/plugins/greeting-cards/components/GreetingCardRecentRuns.vue:1-30`, `apps/admin/plugins/greeting-cards/components/GreetingCardFunnel.vue:1-30`, `apps/api/src/routes/v1/admin/greeting-cards/stats.ts:40-60,62-89,140-178,172-225`, `apps/api/src/routes/v1/admin/greeting-cards/funnel.ts:58-76,96-135`). Sales reporting excludes test-priced and refunded orders (`apps/api/src/routes/v1/admin/greeting-cards/stats.ts:83-99,114-128,140-156`). | [Admin API reference](../../apps/api/docs/api.md), [public greeting-card tools](../features/public-tools.md), [greeting-card delivery](../flows/media/greeting-card-delivery.md) |
| Choose up to three published presets per onboarding audience. | Admin saves ordered lists; API validates and replaces them (`apps/api/src/routes/v1/admin/onboarding/routes.ts:107-132`, `apps/api/src/routes/v1/admin/onboarding/handlers.ts:171-198`). | [Onboarding feature](../features/onboarding.md), [admin configuration API](../../apps/admin/docs/api/configuration.md) |
| Inspect onboarding-to-paid-generation conversion by signup-day cohort. | Admin-read funnel returns profile, demo, look try-on, first non-onboarding generation, captured payment, paid generation, insufficient-balance hit counts and median elapsed seconds (`apps/api/src/routes/v1/admin/analytics/handlers.ts:17-24`, `apps/api/src/routes/v1/admin/analytics/service.ts:48-161`). | [Onboarding feature](../features/onboarding.md), [Operator tools](../features/operator-tools.md) |
| Inspect onboarding users by signup date, last step, recent screens, generation, payment, and engagement time. | The stuck-user report aggregates Cabinet journey events for cohort users and joins them to onboarding steps, generation and payment state (`apps/api/src/routes/v1/admin/onboarding/service.ts:142-160,192-220`). User timelines include other user events, generation, transaction and audit records; their user-event branch excludes Cabinet journey event types (`apps/api/src/routes/v1/admin/users/users-timeline.routes.ts:118-145,230-245`). | [Onboarding feature](../features/onboarding.md), [Operator tools](../features/operator-tools.md) |
| Use the admin shell, plugin navigation, confirmation UI, mutation-reason helper, data tables, and article editor extensions. | Admin Nuxt app; screens load from discovered manifests (`apps/admin/app/layouts/admin.vue:1-52`, `apps/admin/plugins/_shared/discoverPlugins.ts:31-80`). | [Admin shared UI](../../apps/admin/docs/features/admin-shared-ui.md) |
| Read KPI, funnel, revenue, traffic, cohort, and health summaries. | Admin report screens; Trends prompt templates are read-only (`apps/admin/plugins/dashboard/manifest.ts:1-30`, `apps/admin/plugins/statistics/manifest.ts:1-38`, `apps/admin/plugins/trends/manifest.ts:1-22`). | [Analytics](../../apps/admin/docs/features/analytics.md) |
| Manage styles, categories, catalog photos, classification, and prompt backfill. | Admin Photosets offers separate queued classification and prompt-backfill actions (`apps/admin/plugins/photosets/manifest.ts:3-19`, `apps/admin/plugins/photosets/components/PhotosetFolderPhotos.vue:223-250`, `apps/api/src/routes/v1/admin/catalog/photos/routes.ts:147-165`, `apps/api/src/routes/v1/admin/catalog/photos/handlers.ts:324-351`). | [Catalog, categories, and photosets](../../apps/admin/docs/features/catalog.md) |
| Inspect message queues, templates, campaigns, A/B tests, VK campaigns/submissions, and challenge outcomes. | VK wall publishing uses authenticated idempotent BFF mutations (`apps/admin/plugins/messages/manifest.ts:1-35`, `apps/admin/plugins/vk-campaigns/manifest.ts:1-38`). | [Communications](../../apps/admin/docs/features/communications.md), [VK promo flow](../flows/vk-promo.md) |
| Manage system settings, roles, team membership, feature flags, localization, onboarding experiments, landing blocks, and legal operator profiles. | Each Admin plugin exposes its own routes and scope; onboarding experiments use `/admin/onboarding`, while configuration and flags have separate plugin manifests (`apps/admin/plugins/onboarding/manifest.ts:19-38`, `apps/admin/plugins/settings/manifest.ts:1-41`, `apps/admin/plugins/feature-flags/manifest.ts:1-35`). | [Configuration](../../apps/admin/docs/features/configuration.md) |
| Manage article drafts, metadata, tags, ideas, publishing actions, article generation, and writer tasks. | Writer progress streams to Admin; API owns article records. Publishing triggers IndexNow and best-effort Yandex Webmaster recrawl; ingest returns its recrawl result (`apps/admin/plugins/articles/manifest.ts:1-44`, `apps/admin/plugins/article-writer/manifest.ts:1-23`, `apps/api/src/routes/v1/admin/articles/handlers.ts:193-228`, `apps/api/src/routes/v1/admin/articles/ingest.ts:187-212`). | [Content](../../apps/admin/docs/features/content.md), [content flow](../flows/content.md) |
| Review acquisition, links, funnel, sessions, customer attribution, spend, costs, and quality; record marketing spend. | Spend currency is selected; FX valuation is entered separately (`apps/admin/plugins/marketing/manifest.ts:1-42`, `apps/admin/plugins/marketing/components/SpendForm.vue:170-199`). | [Marketing](../../apps/admin/docs/features/marketing.md) |
| Upload, preview, publish, and version assets, public pages, galleries, feeds, and document-photo orders. | Scoped Admin API routes (`apps/admin/plugins/media/manifest.ts:1-36`, `apps/admin/plugins/pages/manifest.ts:1-43`, `apps/admin/plugins/docs-photo/manifest.ts:1-19`). | [Media and publication](../../apps/admin/docs/features/media-publication.md) |
| Triage alerts, moderate content, process hide requests, review live proof, and inspect feeds. | API authorization and moderation rules apply (`apps/admin/plugins/alerts/manifest.ts:1-33`, `apps/admin/plugins/moderation/manifest.ts:1-35`, `apps/admin/plugins/hide-requests/manifest.ts:1-27`). | [Operations](../../apps/admin/docs/features/operations.md) |
| Configure or inspect scenarios, sandbox runs, AI models/providers, and executor/login state. | Admin provides scenario and sandbox screens; execution admission and runtime behavior are owned by the scenario-runner and its API routes (`apps/admin/plugins/scenarios/manifest.ts:1-45`, `apps/admin/plugins/sandbox/manifest.ts:1-40`, `apps/scenario-runner/src/main.ts:213-235`). | [Scenarios and AI](../../apps/admin/docs/features/scenarios-ai.md) |
| Manage SEO clusters and run scenario content operations. | Cluster evidence, Jev analysis and links, plus profession-page photosets, are detailed in [SEO and scenario content operations](operators/seo-and-scenario-content.md). Scenario source selection, content publishing and media execution are listed in [scenario-runner capabilities](operators/scenario-runner.md). | [SEO sites](../../apps/admin/docs/features/seo-sites.md), [scenario media](../../apps/scenario-runner/docs/features/media-and-catalog.md) |
| Edit SEO landing V2 content and catalog facets. | The SEO-landings detail editor selects a page kind, manages five facets and edits the template blocks enabled for that kind (`apps/admin/plugins/seo-landings/pages/[id].vue:1-8`, `apps/admin/plugins/seo-landings/components/shoot-content-v2.ts:12-52,160-179`). | [Operator tools](../features/operator-tools.md), [SEO sites](../../apps/admin/docs/features/seo-sites.md) |
| Manage site-tool hub entries and docs-photo/Pixar V2 copy. | Admin edits placement, status, order and presentation fields, with V2 copy panels for both slugs (`apps/admin/plugins/site-tools/manifest.ts:15-20`, `apps/admin/plugins/site-tools/components/SiteToolsHubCatalogPanel.vue:53-79`, `apps/admin/plugins/site-tools/components/SiteToolsV2PageCopyEditor.vue:24-65`). | [Operator tools](../features/operator-tools.md), [admin overview](../../apps/admin/docs/overview.md) |
| Configure scenario autopilot for an active scenario. | Enabling it in Admin requires a selected cluster group; on each minute tick, generic scenarios select eligible clusters from that group, while `greeting-card-page-v1` selects eligible existing pages from the greeting-card page tree. Each tick fills the available concurrency without exceeding the daily run limit. Three consecutive non-shutdown failed runs since the last resume pause the scenario (`apps/admin/plugins/scenarios/components/ScenarioClusterSource.vue:131-156`, `apps/api/src/routes/v1/admin/scenarios/autopilot.ts:12-23,70-99,124-170`, `apps/api/src/routes/v1/admin/scenarios/cluster-source.routes.ts:55-87,167-186`, `apps/api/src/routes/v1/admin/scenarios/card-page-source.ts:4-46`). | [Scenario workspace](../../apps/scenario-runner/docs/overview.md), [scenario autopilot](../../apps/api/docs/features/scenario-autopilot.md), [SEO cluster administration](../../apps/api/docs/api.md#seo-cluster-and-article-administration) |
| Use the Russian-first operator UI and Nitro backend-for-frontend for API operations. | Compose builds and runs the `admin` service from `apps/admin` on port 4003 (`docker-compose.yml:709-738`). | [Admin workspace runtime](../../apps/admin/docs/features/workspace-runtime.md), [admin overview](../../apps/admin/docs/overview.md) |
| List editorial/CMS articles and catalog styles through the Admin API. | Admin role and `admin:read` are required; article listing combines editorial and CMS projections, while catalog listing supports filters and cursors (`apps/api/src/routes/v1/admin/articles/routes.ts:43-50`, `apps/api/src/routes/v1/admin/articles/handlers.ts:79-85`, `apps/api/src/routes/v1/admin/catalog/handlers.ts:63-101`). | [Admin list handlers](../../apps/api/docs/features/admin-list-handlers.md) |
| Start the API service after environment and production-adapter validation, then stop jobs and drain HTTP requests on SIGTERM/SIGINT. | Startup aborts on invalid environment or disallowed deferred money/queue adapters; after listen, the API starts jobs and projections, and graceful shutdown drains with the configured deadline (`apps/api/src/main.ts:69-88,242-260,340-379`). | [API process startup](../../apps/api/docs/features/api-process-startup.md), [deployment](../deployment.md) |
| Use authenticated API CRUD/reporting, internal endpoints, partner imports, operations streams, and integrations. | Admin scope or internal-service authorization (`apps/api/src/routes/v1/admin/index.ts:63-122`, `apps/api/src/server.ts:587-633`). | [API admin and integrations](../../apps/api/docs/features/admin-and-integrations.md), [operator tools](../features/operator-tools.md) |
| Publish VK campaign posts/stories and schedule personal-wall posts. | Personal-wall posts enqueue browser commands with an idempotency key (`apps/vk-bot/src/auto-publisher.ts:89-104`). | [Campaign publishing](../../apps/vk-bot/docs/features/campaign-publishing.md), [VK promo flow](../flows/vk-promo.md) |
| Retry failed promo submissions whose only missing condition is a like, repost, or friend gate. | Only like/repost/friend gate failures enter; wait closes after 12 hours (`apps/vk-bot/src/pipeline.ts:265-300`). | [Gate reminders](../../apps/vk-bot/docs/features/gate-reminders.md), [VK promo flow](../flows/vk-promo.md) |
| Accept VK comment candidates, record durable intake, process submissions, and reply to comments. | API and Redis intake; campaign status and gates govern acceptance (`apps/vk-bot/src/pipeline.ts:142-179`). | [Submission processing](../../apps/vk-bot/docs/features/submission-processing.md), [VK promo options and pricing](../flows/vk-promo/capabilities.md), [VK promo flow](../flows/vk-promo.md) |
| Inspect executor health and model catalogs, request health refreshes, and start supported CLI login tasks. | Health reads require `admin:read`; refresh requires `admin:write` and an idempotency key; login and code submission require owner role, `admin:write`, and an idempotency key. Model reports use the internal API secret (`apps/api/src/routes/v1/admin/executors/routes.ts:253-283,286-303,305-320,354-415,419-472`). | [Executor administration](../../apps/api/docs/features/executor-admin.md) |
| Run scenario executors for coding agents, CLI health, and login workflows. | The runner dispatches tasks to registered executors; CLI tasks use the configured provider and credential home (`apps/scenario-runner/src/executors/index.ts:137-155`, `apps/scenario-runner/src/cli-registry/task.ts:39-45`). | [CLI agents](../../apps/scenario-runner/docs/features/cli-agents.md), [CLI registry](../../apps/scenario-runner/docs/features/cli-registry.md), [executor administration](../../apps/api/docs/features/executor-admin.md) |
| Assemble shoot-page outputs, write candidates, or query published pages through runner executors. | Executors register only when their prerequisites are present (`apps/scenario-runner/src/executors/index.ts:89-94,150-153,183-189,191-207`). | [Content publishing](../../apps/scenario-runner/docs/features/content-publishing.md), [executor details](../../apps/scenario-runner/docs/features/content-publishing-executor-details.md), [internals](../../apps/scenario-runner/docs/features/content-publishing-internals.md) |
| Produce profession-page shoot media and prepare its frames as a Cabinet photoset. | See [SEO and scenario content operations](operators/seo-and-scenario-content.md). | [Media and catalog](../../apps/scenario-runner/docs/features/media-and-catalog.md) |
| Produce search, image, cluster, and idea artifacts for content/SEO playbooks. | Configured scenario executor steps (`apps/scenario-runner/src/executors/index.ts:94-104`). | [Research and analysis](../../apps/scenario-runner/docs/features/research-and-analysis.md) |
| Execute scenario playbooks and return step outcomes and artifacts. | The runner interpolates prompts and serializes each step outcome into its completion result (`apps/scenario-runner/src/main.ts:213-235,268-299`). | [Scenario execution](../../apps/scenario-runner/docs/features/scenario-execution.md) |
| Authenticate agent-runner requests, lease tasks, persist runner events/results, and finalize accepted results. | Valid runner signature and task lease required (`apps/worker/src/lib/agent-runner-broker.ts:117-242`). | [Worker agent runner](../../apps/worker/docs/features/agent-runner.md) |
| Run scene analysis and catalog-photo prompt-generation/classification consumers. | Matching queue consumer and provider configuration required (`apps/worker/src/main.ts:524-543`). | [Analysis and catalog](../../apps/worker/docs/features/analysis-catalog.md) |
| Process queued image-generation jobs through provider execution and compensation. | The worker starts the generation queue consumer; terminal provider failures mark the generation failed and run refund compensation (`apps/worker/src/main.ts:486-510`, `apps/worker/src/sagas/process-generation-job.ts:1360-1428`). | [Worker generation](../../apps/worker/docs/features/generation.md), [generation flow](../flows/generation.md) |
| Run maintenance sweeps for stale generation/payment work, wallet integrity, analytics/subscriptions, and document-photo orders. | Only registered sweeps run (`apps/worker/src/main.ts:761-999`). | [Worker maintenance](../../apps/worker/docs/features/maintenance.md) |
| Send a provider-capacity report to the configured owner through Telegram. | Reports yesterday's provider generation counts, KIE request and in-flight peaks, provider 429 counts, and optional Fal balance and 28-day spend. Missing metric data is labeled; delivery uses rich Telegram messages when configured with a plain-message fallback (`apps/worker/src/jobs/provider-capacity-report.ts:230-390,393-456`, `apps/worker/src/main.ts:878-905`). | [Worker maintenance](../../apps/worker/docs/features/maintenance.md), [operator tools](../features/operator-tools.md) |
| Run a manifest-driven database audit in static or live mode, by phase or detector, validate results, or compare project reports. | Live preflight checks the selected database client and PostgreSQL read-only state; detector failures are reported and phase validation determines the phase result (`database-audit/run.sh:21-36,66-113,116-164`, `database-audit/validators/preflight.py:16-75`). | [Operator tools](../features/operator-tools.md) |
| Deliver durable messages, translate locales, and emit generation notifications. | Requires the message/translation consumer or generation terminal path (`apps/worker/src/main.ts:545-567`, `apps/worker/src/sagas/process-generation-notify.ts:65-124`). | [Messages and localization](../../apps/worker/docs/features/messages-localization.md) |
| Poll the shared outbox and apply visibility cache/CDN invalidation. | Requires registered visibility consumers (`apps/worker/src/main.ts:372-423`). | [Worker visibility](../../apps/worker/docs/features/visibility.md) |
| Inspect real-user media-origin measurements by country and Russian ISP. | `/admin/media-origins` shows sample count, success and timeout rates, median and p90 duration. The selected date range is limited to 90 days; API reads require `admin:read` (`apps/admin/plugins/media-origins/manifest.ts:3-18`, `apps/admin/plugins/media-origins/pages/index.vue:30-63,94-148`, `apps/api/src/routes/v1/admin/media-probe/routes.ts:40-68,72-135`). | [Operator tools](../features/operator-tools.md), [API localization and media probes](../../apps/api/docs/features/localization-and-media-probes.md) |
| Use the Admin API to manage translation publication for CMS pages, articles, SEO landings and site-tool pages. | `admin:read` opens the locale matrix and settings; `admin:write` updates publication locales and queues/retries, publishes, unpublishes or skips translations. Queueing accepts configured locales and supported content types; failed enqueue is recorded as `failed` (`apps/api/src/routes/v1/admin/localization/routes.ts:103-135,138-204,208-275,278-310`, `apps/api/src/routes/v1/admin/localization/constants.ts:1-24`, `apps/api/src/routes/v1/admin/localization/service.ts:191-224`). | [API localization and media probes](../../apps/api/docs/features/localization-and-media-probes.md), [Admin configuration](../../apps/admin/docs/features/configuration.md) |

<!-- lane-pilot:backlinks -->
## Referenced by

- [SelfyStudio Admin API Routes](../../apps/api/docs/admin-api.md)
- [SelfyStudio API map](../api.md)
- [SelfyStudio capabilities](../capabilities.md)
- [API and user capabilities](api-and-user-capabilities.md)
