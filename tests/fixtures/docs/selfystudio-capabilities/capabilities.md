---
title: SelfyStudio capabilities
type: capabilities
created: 2026-09-27
updated: 2026-10-20
status: active
confidence: low
tags: [capabilities, product, limits]
sources:
  - apps/marketing/app/pages/blog/index.vue
  - apps/marketing/app/pages/blog/category/[slug].vue
  - apps/marketing/server/routes/sitemap-blog.xml.ts
  - apps/marketing/app/pages/photos/index.vue
  - apps/marketing/app/pages/photos/[code].vue
  - packages/contracts/src/admin/site-tool-landing.ts
  - apps/marketing/app/components/tools/ToolLandingTemplate.vue
  - apps/marketing/app/utils/route-namespaces.ts
  - apps/marketing/app/plugins/attribution.client.ts
  - apps/marketing/app/components/tools/DocsPhotoGenerator.vue
  - packages/site-flows/src/docs-photo/useDocsPhotoFlow.ts
  - packages/site-flows/src/docs-photo/attribution.ts
  - packages/contracts/src/docs-photo/index.ts
  - apps/api/src/routes/v1/docs-photo-payments.ts
  - apps/api/src/routes/v1/site-tools/public-hub-catalog-route.ts
  - apps/api/src/routes/v1/site-tools/public-index.ts
  - apps/marketing/app/pages/webapp/catalog/index.vue
  - apps/api/src/routes/v1/public-site-tools.ts
  - apps/api/src/routes/v1/site-tools/visitor.ts
  - packages/infrastructure/persistence-prisma/prisma/migrations/20260928120000_site_tool_free_generation/migration.sql
  - apps/cabinet/app/middleware/auth.global.ts
  - apps/cabinet/app/entities/onboarding/first-run.ts
  - apps/api/src/routes/v1/onboarding/recommended-sets.ts
  - apps/api/src/routes/v1/onboarding/presets.ts
  - apps/cabinet/app/widgets/OnboardingFirstRun.vue
  - apps/cabinet/server/api/cabinet/wallet/topup.post.ts
  - apps/cabinet/server/api/cabinet/subscriptions/checkout.post.ts
  - apps/cabinet/app/features/carousel/store.ts
  - apps/cabinet/server/api/cabinet/carousels/index.post.ts
  - apps/cabinet/app/features/chat-studio/ChatStudio.vue
  - apps/cabinet/server/api/cabinet/chat-access.get.ts
  - apps/cabinet/server/api/cabinet/discover-feed.get.ts
  - apps/cabinet/server/api/cabinet/favorites/[generationId].post.ts
  - apps/cabinet/server/api/cabinet/generations.post.ts
  - apps/cabinet/app/entities/user/use-wardrobe-beta.ts
  - apps/marketing/app/components/greeting-cards/CardCheckout.vue
  - apps/marketing/i18n/locales/ru.json
  - apps/marketing/i18n/locales/en.json
  - apps/api/src/routes/v1/users-me.ts
  - apps/api/src/routes/v1/users-me/generations.routes.ts
  - apps/api/src/routes/v1/wallet-topup.ts
  - apps/api/src/routes/v1/webhooks.ts
  - apps/api/src/routes/v1/auth-by-telegram-id.ts
  - apps/api/src/routes/v1/_helpers/internal-auth.ts
  - apps/api/src/routes/v1/chat-sessions/index.ts
  - apps/api/src/routes/v1/uploads/presigned.ts
  - apps/api/src/routes/v1/generations/start.routes.ts
  - apps/api/src/routes/v1/generations/resolve-generation-intake.ts
  - apps/api/src/routes/v1/_shared/public-generation-predicate.ts
  - apps/bot-thin/src/features/cabinet/menu.ts
  - apps/bot-thin/src/features/generation/shared/precondition-checks.ts
  - apps/bot-thin/src/features/history/grid/render.ts
  - apps/bot-thin/src/features/imports/instagram.ts
  - apps/bot-thin/src/handlers/start.ts
  - apps/bot-thin/src/handlers/notify.ts
  - apps/bot-thin/src/shared/deeplink/parse-start-payload.ts
  - apps/bot-thin/src/handlers/repeat-intent.ts
  - apps/bot-thin/src/features/profile/create/handlers/confirmation.ts
  - apps/api/src/routes/v1/profiles.ts
  - packages/application/src/generation/use-cases/start-generation.ts
  - apps/admin/plugins/payments/manifest.ts
  - apps/admin/app/layouts/admin.vue
  - apps/admin/plugins/trends/manifest.ts
  - apps/admin/plugins/catalog/manifest.ts
  - apps/admin/plugins/challenges/manifest.ts
  - apps/admin/plugins/onboarding/manifest.ts
  - apps/admin/plugins/articles/manifest.ts
  - apps/api/src/routes/v1/admin/articles/handlers.ts
  - apps/api/src/routes/v1/admin/articles/service.ts
  - apps/api/src/routes/v1/admin/catalog/handlers.ts
  - apps/api/src/routes/v1/admin/catalog/service.ts
  - apps/api/src/routes/v1/admin/challenges/routes.ts
  - apps/api/src/routes/v1/_shared/social-viewer.ts
  - apps/admin/plugins/marketing/manifest.ts
  - apps/admin/plugins/docs-photo/manifest.ts
  - apps/admin/plugins/live-proof/manifest.ts
  - apps/admin/plugins/scenarios/manifest.ts
  - apps/admin/plugins/landing-config/manifest.ts
  - apps/admin/nuxt.config.ts
  - apps/api/src/routes/v1/admin/index.ts
  - apps/cabinet/app/pages/login.vue
  - apps/cabinet/app/widgets/CommunityFeed.vue
  - apps/scenario-runner/src/executors/index.ts
  - apps/scenario-runner/src/executors/card-page/card-page-executor.ts
  - apps/scenario-runner/src/persist/read-started-by-admin.ts
  - apps/scenario-runner/src/cli-registry/task.ts
  - apps/scenario-runner/src/main.ts
  - apps/vk-bot/src/auto-publisher.ts
  - apps/vk-bot/src/pipeline.ts
  - apps/worker/src/lib/agent-runner-broker.ts
  - apps/worker/src/main.ts
  - apps/worker/src/sagas/process-generation-job.ts
  - apps/api/src/composition/env-validator.ts
  - apps/api/scripts/seo-cocoon/generate-cocoon.mjs
  - apps/api/scripts/seo-cocoon/publish-page.mjs
  - apps/admin/plugins/onboarding/components/StuckUsersCard.vue
  - apps/admin/plugins/scenarios/components/ScenarioClusterSource.vue
  - apps/api/src/routes/v1/admin-seo-clusters-crud.routes.ts
  - apps/api/src/routes/v1/admin/scenarios/cluster-source.routes.ts
  - apps/api/src/routes/v1/public-cards/generate.ts
  - apps/api/src/routes/v1/public-cards/store-faces.ts
  - apps/api/src/routes/v1/greeting-cards-shared/group-prompt.ts
  - apps/api/src/routes/v1/greeting-cards-shared/holiday-greeting.ts
  - apps/api/src/routes/v1/greeting-cards-shared/design-source.ts
  - apps/api/src/routes/v1/admin/greeting-cards/page-content.ts
  - apps/api/src/routes/v1/admin/greeting-cards/ai-designs.ts
  - apps/api/src/routes/v1/public-cards/shared.ts
  - apps/api/src/routes/v1/public-cards-checkout/routes.ts
  - apps/api/src/routes/v1/public-cards-checkout/constants.ts
  - apps/api/src/routes/v1/public-cards/pages.ts
  - apps/marketing/app/components/greeting-cards/CardPageRenderer.vue
  - apps/api/src/routes/v1/admin/greeting-cards/seed-catalog.ts
  - apps/api/src/routes/v1/admin/greeting-cards/routes.ts
  - apps/api/src/routes/v1/admin/greeting-cards/page-content.ts
  - apps/api/src/routes/v1/public-cards-checkout/fulfill.ts
  - apps/api/src/routes/v1/public-cards-checkout/packs.ts
  - apps/api/src/routes/v1/users-greeting-cards.ts
  - apps/cabinet/app/pages/cards.vue
  - apps/marketing/app/components/greeting-cards/generator/GeneratorDesigns.vue
  - apps/api/src/routes/v1/site-tools/card-account.ts
  - apps/api/src/routes/v1/public-cards-checkout/webhook.ts
  - apps/api/src/routes/v1/webhooks-yookassa-pay.ts
  - apps/api/src/routes/v1/public-cards-checkout/test-unlock.ts
  - apps/marketing/app/pages/tools/[slug]/index.vue
  - apps/marketing/app/pages/tools/[slug]/[pageSlug].vue
  - apps/cabinet/app/widgets/ShootSetModal.vue
  - apps/admin/plugins/messages/manifest.ts
  - apps/admin/plugins/vk-campaigns/manifest.ts
  - apps/admin/plugins/settings/manifest.ts
  - apps/admin/plugins/feature-flags/manifest.ts
  - apps/admin/plugins/alerts/manifest.ts
  - apps/admin/plugins/moderation/manifest.ts
  - apps/admin/plugins/hide-requests/manifest.ts
  - apps/admin/plugins/seo-clusters/manifest.ts
  - apps/admin/plugins/seo-landings/manifest.ts
  - apps/admin/plugins/greeting-cards/manifest.ts
  - docker-compose.yml
  - apps/api/src/routes/v1/admin/payment-methods/routes.ts
  - apps/api/src/routes/v1/public-blog-posts.ts
  - apps/marketing/app/components/greeting-cards/CardGenerator.vue
  - apps/admin/plugins/promo-codes/manifest.ts
  - apps/admin/plugins/_shared/discoverPlugins.ts
  - apps/admin/server/api/admin/[...path].ts
  - apps/admin/plugins/statistics/manifest.ts
  - apps/admin/plugins/marketing/components/SpendForm.vue
  - apps/admin/plugins/photosets/composables/usePhotosetWorkspace.ts
  - apps/admin/plugins/article-writer/manifest.ts
  - apps/admin/plugins/pages/manifest.ts
  - apps/admin/plugins/media/manifest.ts
  - apps/admin/plugins/media-origins/manifest.ts
  - apps/admin/plugins/media-origins/pages/index.vue
  - apps/api/src/routes/v1/admin/media-probe/routes.ts
  - apps/admin/plugins/sandbox/manifest.ts
  - apps/marketing/app/pages/index.vue
  - apps/vk-bot/src/gate-wait-sweeper.ts
  - docs/capabilities/platform-workflows.md
  - apps/api/src/routes/v1/_shared/content-locale-published.ts
---

# SelfyStudio capabilities

TL;DR: Implemented user and operator actions, linked to flow and feature pages.

## Map

- **Images:** [generation](features/generation.md), [modes](flows/image-generation.md).
- **Editing:** [carousel](features/carousel.md), [photo studio](features/photo-studio.md), [constructor](features/constructor.md).
- **Account/social:** [account](features/account.md), [identity](flows/identity.md), [profile](flows/profile.md), [collections](features/collections.md).
- **Payments:** [wallet](features/payments.md), [billing](flows/billing.md), [providers](flows/payment.md).
- **Public:** [content](flows/content.md), [VK promo](flows/vk-promo.md), [sticker packs](capabilities/stickers.md), [operator tools](capabilities/operator-tools.md).
- **Platform workflows:** [API webhooks, Cabinet billing and generation](capabilities/platform-workflows.md).

### Public and user surfaces
Greeting-card capabilities and their detailed conditions are listed in [greeting-card capabilities](capabilities/greeting-cards.md).
See [Marketing page capabilities](capabilities/marketing-api-callers.md).
More public-page and visitor-facing capabilities: [Public surface capabilities](capabilities/public-surfaces.md).
Other workspaces: [capabilities](capabilities/workspace-details.md); API and user additions: [capabilities](capabilities/api-and-user-capabilities.md).

| Capability | Availability and conditions | Details |
|---|---|---|
| Browse Marketing pages and tools: blog, photos, SEO landings, localized tool pages, document-photo and greeting-card experiences. | Public route families and page-specific conditions are catalogued in the Marketing capability page; the shared route map and public API own locale and publication behavior (`apps/marketing/app/utils/route-namespaces.ts:46-89`, `apps/api/src/routes/v1/_shared/content-locale-published.ts:17-30,62-82`). | [Marketing page capabilities](capabilities/marketing-api-callers.md), [public pages and SEO](../apps/marketing/docs/features/public-pages-and-seo.md), [content flow](flows/content.md) |
| Cabinet sign-in, identity linking, profile/selfie management, settings, and support. | Protected pages require a session; first run limits recommendations to three sets, and the API returns solo/duo costs (`apps/cabinet/app/middleware/auth.global.ts:29-31,59-65`, `apps/cabinet/app/entities/onboarding/first-run.ts:8`, `apps/api/src/routes/v1/onboarding/recommended-sets.ts:63-80`). | [Auth and profiles](../apps/cabinet/docs/features/auth-and-profiles.md), [Onboarding](features/onboarding.md) |
| Complete the first-run demo and per-profile free look try-on; compare current shoot cost with wallet balance and open top-up when underfunded. | The home result uses the live balance and cost; the shoot-set modal shows its price and balance and offers top-up when short (`apps/cabinet/app/widgets/OnboardingFirstRun.vue:804-828`, `apps/cabinet/app/widgets/ShootSetModal.vue:95-120,181-192`). | [Profile flow](flows/profile.md), [Onboarding Look and Manicure](flows/content/onboarding-look.md), [Onboarding feature](features/onboarding.md) |
| Buy wallet tokens or subscription tiers through cabinet checkout. | A valid `cabinet_session` is required; top-up requests are forwarded to the API and subscription checkout is a pass-through (`apps/cabinet/server/api/cabinet/wallet/topup.post.ts:19-22,45-76`, `apps/cabinet/server/api/cabinet/subscriptions/checkout.post.ts:44-46,60-83`). | [Cabinet billing](../apps/cabinet/docs/features/billing.md) |
| Create and edit multi-slide carousel posts. | Signed-in cabinet user; cabinet Nitro persists records and proxies assistant/image work (`apps/cabinet/app/features/carousel/store.ts:1-30`, `apps/cabinet/server/api/cabinet/carousels/index.post.ts:1`). | [Carousel editor](../apps/cabinet/docs/features/carousel-editor.md), [carousel flow](flows/carousel.md) |
| Open assistant conversations, review history, and submit messages. | Chat access check gates API session routes (`apps/cabinet/app/features/chat-studio/ChatStudio.vue:1-60`, `apps/cabinet/server/api/cabinet/chat-access.get.ts:1`). | [Chat Studio](../apps/cabinet/docs/features/chat-studio.md), [chat flow](flows/chat.md) |
| Browse public generations and authors; manage personal favorites and collections. | Public reads; signed-in owner writes (`apps/cabinet/server/api/cabinet/discover-feed.get.ts:1`, `apps/cabinet/server/api/cabinet/favorites/[generationId].post.ts:1`). | [Community and library](../apps/cabinet/docs/features/community-and-library.md), [collection flow](flows/collection.md) |
| Request mode-specific image generation from the cabinet. | Authenticated proxy; mode validated; wardrobe IDs require beta (`apps/cabinet/server/api/cabinet/generations.post.ts:34-98`). | [Cabinet generation](../apps/cabinet/docs/features/generation.md), [generation flow](flows/generation.md) |
| Create or edit wardrobe sets and use them as generation inputs. | Wardrobe beta required; proxy strips set IDs without entitlement (`apps/cabinet/app/entities/user/use-wardrobe-beta.ts:13-21`, `apps/cabinet/server/api/cabinet/generations.post.ts:71-74`). | [Wardrobe](../apps/cabinet/docs/features/wardrobe.md), [photo-studio flow](flows/photo-studio.md) |
| Read and update account resources through the `/v1/users/me/*` route group. | The self-service generation and data-export routes use API authentication (`apps/api/src/routes/v1/users-me.ts:32-43`, `apps/api/src/routes/v1/users-me/generations.routes.ts:71,188`). | [API user account and cabinet](../apps/api/docs/features/user-account-and-cabinet.md), [account](features/account.md), [identity](flows/identity.md) |
| Create a payment checkout, manage wallet balance, and receive payment callbacks. | Top-ups require auth; callbacks use webhooks (`apps/api/src/routes/v1/wallet-topup.ts:119-126`; `apps/api/src/routes/v1/webhooks.ts:80-121`). | [API wallet and payments](../apps/api/docs/features/wallet-and-payments.md), [payment flows](flows/payment.md) |
| Authenticate through password/session and external identity-provider routes. | Internal secret required for Telegram-ID lookup (`apps/api/src/routes/v1/auth-by-telegram-id.ts:54-56`; `apps/api/src/routes/v1/_helpers/internal-auth.ts:8-17`). | [API authentication and sessions](../apps/api/docs/features/authentication-and-sessions.md), [identity flow](flows/identity.md) |
| Create chat sessions, send messages, and upload user media. | Authenticated user; photo uploads use presigned routes (`apps/api/src/routes/v1/chat-sessions/index.ts:42-273`, `apps/api/src/routes/v1/uploads/presigned.ts:31-38`). | [API chat sessions and uploads](../apps/api/docs/features/chat-sessions-and-uploads.md), [chat flow](flows/chat.md), [media flow](flows/media.md) |
| Submit generation requests with profile, reference, and wardrobe inputs. | Authenticated request; API validates intake and profile ownership before paid start (`apps/api/src/routes/v1/generations/start.routes.ts:54-68`, `apps/api/src/routes/v1/generations/resolve-generation-intake.ts:115-264`). | [API generation and profile intake](../apps/api/docs/features/generation-and-profile-intake.md), [generation flow](flows/generation.md) |
| Read published pages, articles, catalog/search, SEO landings, social surfaces, site tools, and public feeds. | The article handler restricts ordinary reads to published, unarchived records; generation feeds apply their visibility predicate (`apps/api/src/routes/v1/public-blog-posts.ts:835-859`, `apps/api/src/routes/v1/_shared/public-generation-predicate.ts:14-47`). | [API public content and catalog](../apps/api/docs/features/public-content-and-catalog.md), [content flow](flows/content.md) |
| Generate and publish SEO landing content from command-line tools. | Operator CLI; publish emits SQL for review or `psql` (`apps/api/scripts/seo-cocoon/generate-cocoon.mjs:18-46`, `apps/api/scripts/seo-cocoon/publish-page.mjs:45-76`). | [SEO Cocoon publishing](../apps/api/docs/features/seo-cocoon-publishing.md) |
| Load greeting-card page context, validate a draft without saving, and persist page content. | Available through the Admin greeting-card workspace and API; context reads require `admin:read`, content writes require `admin:write` and `Idempotency-Key`, and the factory context workflow excludes hub pages. A successful non-dry-run content save publishes the page; when no published design exists and the page is configured to own designs, the API starts an AI design job (`apps/admin/plugins/greeting-cards/manifest.ts:9-19`, `apps/api/src/routes/v1/admin/greeting-cards/routes.ts:17-31`, `apps/api/src/routes/v1/admin/greeting-cards/page-content.ts:269-280,300-351`). | [Greeting-card content operations](../apps/api/docs/features/greeting-card-content-operations.md), [operator capabilities](capabilities/operators.md) |
| Present account actions, top-ups, subscriptions, promo codes, gifts, and referrals in Telegram. | Telegram bot; account and purchase actions use API state (`apps/bot-thin/src/features/cabinet/menu.ts:143-187`). | [Telegram cabinet and payments](../apps/bot-thin/docs/features/cabinet-and-payments.md), [billing flow](flows/billing.md) |
| Start Telegram generation, including pair shoots opened from catalog-style deep links. | Bot resolves the style and starts duo photoshoot generation (`apps/bot-thin/src/shared/deeplink/parse-start-payload.ts:34-35,81-83`, `apps/bot-thin/src/handlers/start.ts:275-294`, `apps/bot-thin/src/handlers/repeat-intent.ts:76-134`). | [Telegram generation](../apps/bot-thin/docs/features/generation.md), [bot session](flows/bot-session.md), [generation flow](flows/generation.md) |
| Browse generation history, favorite or repeat a result, remix it, or refine with text/reference input. | Telegram fetches history through a user-scoped API client; generation actions validate ownership at the API boundary (`apps/bot-thin/src/features/history/grid/render.ts:197-210`, `apps/api/src/routes/v1/generations/resolve-generation-intake.ts:319-363`). | [History and remix](../apps/bot-thin/docs/features/history-and-remix.md), [generation flow](flows/generation.md) |
| Import an Instagram post or reel and choose one of its photos as a generation input. | Telegram accepts `instagram.com/p/` and `/reel/` links, imports the gallery and hands the chosen photo to mode selection (`apps/bot-thin/src/features/imports/instagram.ts:37-40,101-141,215-228`). | [Telegram imports](../apps/bot-thin/docs/features/imports.md) |
| Receive generation progress/results and payment/account notifications in Telegram. | Internal secret required before dispatch (`apps/bot-thin/src/handlers/notify.ts:1081-1085`). | [Telegram notifications](../apps/bot-thin/docs/features/notifications.md), [bot session flow](flows/bot-session.md) |
| Register new Telegram users, complete welcome/consent screens, and update settings. | New accounts get the tour; `/start` checks consent (`apps/bot-thin/src/handlers/start.ts:264-286`). | [Onboarding and settings](../apps/bot-thin/docs/features/onboarding-and-settings.md), [profile flow](flows/profile.md) |
| Create, edit, recreate, delete, and manage selfies for Telegram profiles. | Telegram submits profile creation to the authenticated profile API (`apps/bot-thin/src/features/profile/create/handlers/confirmation.ts:83-103`, `apps/api/src/routes/v1/profiles.ts:1-23,35-43`). | [Telegram profiles](../apps/bot-thin/docs/features/profiles.md), [profile flow](flows/profile.md) |

### Operator and service capabilities

The [operator capability catalogue](capabilities/operators.md) describes shared tools; feature pages own their workflows and constraints.

| Capability | Availability and conditions | Details |
|---|---|---|
| Review accounts, payments, tariffs, promo codes, referral payouts, and profile finance. | Admin; billing/security require API scopes. | [Accounts/finance](../apps/admin/docs/features/accounts-finance.md) (`apps/admin/plugins/payments/manifest.ts:1-34`; `apps/admin/plugins/promo-codes/manifest.ts:1-30`). |
| Navigate admin plugins and use shared confirmations, tables, and editors. | Shared admin UI; BFF proxies authenticated API requests. | [Admin UI](../apps/admin/docs/features/admin-shared-ui.md); [Runtime](../apps/admin/docs/features/workspace-runtime.md) (`apps/admin/plugins/_shared/discoverPlugins.ts:31-80`; `apps/admin/server/api/admin/[...path].ts:1-36`). |
| Inspect KPI, funnel, revenue, traffic, cohort, health, attribution, and spend reports. | Admin; converted spend needs report-currency value. | [Analytics](../apps/admin/docs/features/analytics.md); [Attribution](../apps/admin/docs/features/marketing.md) (`apps/admin/plugins/statistics/manifest.ts:12-28`; `apps/admin/plugins/marketing/components/SpendForm.vue:170-199`). |
| Manage styles, categories, photos, and photoset folders; classify and backfill prompts separately. | Admin; folder summaries do not confirm completion. | [Catalog](../apps/admin/docs/features/catalog.md) (`apps/admin/plugins/photosets/composables/usePhotosetWorkspace.ts:34-40,88-106`). |
| Inspect messages, templates, campaigns, A/B tests, VK submissions, and challenge outcomes. | Admin; VK wall publishing uses authenticated idempotent BFF mutations. | [Communications](../apps/admin/docs/features/communications.md) (`apps/admin/plugins/messages/manifest.ts:1-35`; `apps/admin/plugins/vk-campaigns/manifest.ts:1-38`). |
| Configure settings, roles, team, flags, localization, onboarding, landing blocks, and legal profiles. | Admin; API authorizes mutations. | [Configuration](../apps/admin/docs/features/configuration.md) (`apps/admin/plugins/settings/manifest.ts:1-36`). |
| Draft articles, metadata, tags, and ideas; run article-writer tasks and follow progress. | Admin; API proxies generation. | [Content](../apps/admin/docs/features/content.md) (`apps/admin/plugins/article-writer/manifest.ts:1-23`). |
| Edit CMS pages and their sections, publication state, versions, and A/B settings. | The Pages plugin exposes `/admin/pages` and `/admin/pages/:id`; its manifest assigns `admin:read` and `admin:write` scopes (`apps/admin/plugins/pages/manifest.ts:10-28,39-54`). | [Admin content](../apps/admin/docs/features/content.md), [CMS content API](../apps/admin/docs/api/content.md) |
| Triage alerts, moderation, hide requests, live-proof review, and feed entries. | `apps/admin`; mutations use authenticated API proxies; alert/moderation streams are read-only. | [Operations](../apps/admin/docs/features/operations.md) (`apps/admin/plugins/alerts/manifest.ts:1-33`; `apps/admin/plugins/moderation/manifest.ts:1-35`). |
| Configure scenarios, sandbox runs, AI models/providers, and article-writer operations. | Admin; sandbox runs do not debit wallets. | [Scenarios/AI](../apps/admin/docs/features/scenarios-ai.md) (`apps/admin/plugins/sandbox/manifest.ts:1-40`). |
| Manage SEO clusters/landings, recrawl, teaser review, prompts, and site tools. | Admin; BFF routes previews/mutations; API enforces rules. | [SEO/site tools](../apps/admin/docs/features/seo-sites.md) (`apps/admin/plugins/seo-landings/manifest.ts:1-62`). |
| Serve scoped admin CRUD/reports and integrations; list articles/catalog; manage and finalize weekly challenges. | API; route scopes apply; challenge prizes credit wallets. | [Admin/API](../apps/api/docs/features/admin-and-integrations.md); [Articles](../apps/api/docs/features/admin-article-listing.md); [Catalog](../apps/api/docs/features/admin-catalog-listing.md); [challenges](../apps/api/docs/features/admin-challenges.md) (`apps/api/src/routes/v1/admin/challenges/routes.ts:83-90,111-115,135-139,173-177`). |
| Sign in, create profiles with accepted selfie media and consent, and browse community/library surfaces. | Cabinet; API owns provider/profile handling. | [Auth/profiles](../apps/cabinet/docs/features/auth-and-profiles-workflows.md); [Community/library](../apps/cabinet/docs/features/community-and-library-browsing.md) (`apps/cabinet/app/widgets/CommunityFeed.vue:60-83,142-171`). |
| Generate/purchase greeting cards and serve hub, occasion, name, homepage, blog, gallery, and WebApp pages. | Public marketing app; generator state covers design, photo, consent, run, purchase. | [Card generator](../apps/marketing/docs/features/greeting-card-generator.md); [page sections](../apps/marketing/docs/features/greeting-card-sections.md); [Page behavior](../apps/marketing/docs/features/page-behavior.md) (`apps/marketing/app/components/greeting-cards/CardGenerator.vue:155-195`; `apps/marketing/app/pages/index.vue:13-23`). |
| Run card-page content, CLI agents/registry, content publishing, media/catalog and research executors, and playbooks. | Scenario runner; internal API config gates executors; persistence needs signed admin identity. | [Card-page](../apps/scenario-runner/docs/features/card-page.md); [CLI agents](../apps/scenario-runner/docs/features/cli-agents.md); [CLI registry](../apps/scenario-runner/docs/features/cli-registry.md); [content publishing](../apps/scenario-runner/docs/features/content-publishing.md); [media and catalog](../apps/scenario-runner/docs/features/media-and-catalog.md); [research and analysis](../apps/scenario-runner/docs/features/research-and-analysis.md); [scenario execution](../apps/scenario-runner/docs/features/scenario-execution.md) (`apps/scenario-runner/src/executors/index.ts:89-111,138-181,191-205`). |
| Publish scheduled VK content; process promo submissions and recheck eligible unmet/unverifiable gates. | VK bot; reminder wait closes after 12 hours. | [Campaigns](../apps/vk-bot/docs/features/campaign-publishing.md); [Gate reminders](../apps/vk-bot/docs/features/gate-reminders.md); [Submissions](../apps/vk-bot/docs/features/submission-processing.md) (`apps/vk-bot/src/auto-publisher.ts:1-80`; `apps/vk-bot/src/gate-wait-sweeper.ts:1-80`). |
| Run agent, analysis/catalog, generation, maintenance, messaging/localization, and visibility jobs. | Worker startup registers consumers/sweeps; queues validate and handle failures. | [Agent runner](../apps/worker/docs/features/agent-runner.md); [Analysis/catalog](../apps/worker/docs/features/analysis-catalog.md); [Generation runtime](../apps/worker/docs/features/generation-runtime.md); [generation](../apps/worker/docs/features/generation.md); [maintenance](../apps/worker/docs/features/maintenance.md); [Messages/localization](../apps/worker/docs/features/messages-localization.md); [visibility](../apps/worker/docs/features/visibility.md) (`apps/worker/src/main.ts:372-423,526-587,776-1056`). |
## Terms and costs

Generation prices and payment-method availability are covered by the [API wallet and payments feature](../apps/api/docs/features/wallet-and-payments.md) and [payment flow](flows/payment.md); operators manage the locale-to-provider matrix through the Admin API (`apps/api/src/routes/v1/admin/payment-methods/routes.ts:76-90,194-225`).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Copywriter guide](audiences/copy.md)
- [SEO specialist guide](audiences/seo.md)
- [API and user capabilities](capabilities/api-and-user-capabilities.md)
- [SelfyStudio overview](overview.md)
