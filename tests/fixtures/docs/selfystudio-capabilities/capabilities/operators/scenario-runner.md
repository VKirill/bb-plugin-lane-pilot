---
title: Scenario runner operator capabilities
type: capabilities
created: 2026-10-21
updated: 2026-10-21
status: active
confidence: medium
tags: [operators, scenario-runner, publishing, media]
sources:
  - apps/admin/plugins/scenarios/components/ScenarioClusterSource.vue
  - apps/api/src/routes/v1/admin/scenarios/cluster-source.routes.ts
  - apps/scenario-runner/src/executors/index.ts
  - apps/scenario-runner/src/executors/page-readback/page-readback-executor.ts
  - apps/scenario-runner/src/executors/validate/validate-executor.ts
  - apps/scenario-runner/src/persist/persist-executor.ts
  - apps/scenario-runner/src/executors/persist-article/persist-article-executor.ts
  - apps/scenario-runner/src/executors/frame-download/frame-download-executor.ts
  - apps/scenario-runner/src/executors/shoot-v2-media/shoot-v2-media-executor.ts
  - apps/scenario-runner/src/executors/seed/seed-executor.ts
  - apps/scenario-runner/src/executors/select-frames/select-frames-executor.ts
  - apps/scenario-runner/src/executors/preset-folder/preset-folder-executor.ts
---

# Scenario runner operator capabilities

TL;DR: Admins can configure scenario topic sources and use registered runner steps to publish content, validate pages, generate media and prepare catalog photosets (`apps/admin/plugins/scenarios/components/ScenarioClusterSource.vue:19-46,131-166`, `apps/scenario-runner/src/executors/index.ts:93-115,149-202`).

## Scenario sources and autopilot

In the Admin scenario detail panel, operators can assign or clear an SEO-cluster group, review the eligible-topic count and up to ten preview rows with exact-match Wordstat sums, and edit autopilot concurrency and daily limit. Concurrency is an integer from 1 to 10; the daily limit is 1 to 5,000. Autopilot cannot be enabled without a group, and clearing the group disables it (`apps/admin/plugins/scenarios/components/ScenarioClusterSource.vue:89-108,131-166`, `apps/api/src/routes/v1/admin/scenarios/cluster-source.routes.ts:30-35,149-186`).

## Content publishing and page checks

Scenario runs can read an authenticated landing preview into Markdown and a JSON summary, evaluate blocking and advisory page gates, create or update SEO landings as drafts or publish them when auto-publish gates pass, ingest articles as drafts or publish them when article gates pass, and download selected catalog frames. `page-readback` and `frame-download` are base executors; landing `persist` and `validate` require the SEO-landings client, while `persist-article` requires the internal API secret (`apps/scenario-runner/src/executors/index.ts:108-115,149-153,212-227`). Readback requires a receipt, internal secret and admin identity; `validate`, landing `persist` and article persist require admin identity (`apps/scenario-runner/src/executors/page-readback/page-readback-executor.ts:48-63`, `apps/scenario-runner/src/executors/validate/validate-executor.ts:113-141`, `apps/scenario-runner/src/persist/persist-executor.ts:46-68`, `apps/scenario-runner/src/executors/persist-article/persist-article-executor.ts:82-87`). Article `auto_publish` produces `published` status only when its gate builder returns a summary (`apps/scenario-runner/src/executors/persist-article/persist-article-executor.ts:97-117`). Frame downloads require `preset-folder.json`, `frames.json` and `out_dir` (`apps/scenario-runner/src/executors/frame-download/frame-download-executor.ts:32-46`).

## Media and catalog preparation

Configured scenario runners can select gallery frames, generate seed photos and shoot-page media, create demo pairs, upload generated photos into catalog styles, and download selected frames for reuse. `select-frames` is registered by default; seed, demo-pair and shoot-v2 media require a seed client, GenAI credentials and both profile IDs; `preset-folder` requires a catalog client. `photoset-finalize` additionally requires a Jev client and is omitted when `FF_SCENE_COMPILE` is exactly `false` (`apps/scenario-runner/src/executors/index.ts:99-108,160-202,232-235`). Shoot-v2 writes slot results and per-slot failures to `media.v2.json` and fails if no slot was filled. Frame selection requires `photos.json` plus a draft, defaults to at least four completed photos, and rejects fewer than the configured minimum. Preset-folder skips catalog work when its visual-skip rule matches; otherwise it resolves catalog categories and styles and uploads photos (`apps/scenario-runner/src/executors/shoot-v2-media/shoot-v2-media-executor.ts:92-105,156-172`, `apps/scenario-runner/src/executors/select-frames/select-frames-executor.ts:21-42,61-77`, `apps/scenario-runner/src/executors/preset-folder/preset-folder-executor.ts:44-77,79-114`).

Related: [Operator capabilities](../operators.md), [scenario cluster source and autopilot](../../../apps/admin/docs/features/scenario-cluster-source.md), [content publishing step details](../../../apps/scenario-runner/docs/features/content-publishing-step-details.md), [media execution details](../../../apps/scenario-runner/docs/features/media-execution-details.md).
