---
title: Capability table of providers
type: component
created: 2026-10-23
updated: 2026-10-25
status: active
confidence: medium
tags: [sma, providers, adapters, probe]
sources:
  - src/rooms/capability/logic.ts
  - src/rooms/capability/server/capability.ts
  - packages/handoff/src/registry.ts
  - packages/jev/src/provider.ts
---

# Capability table of providers

A provider is reached through an adapter, its BB plugin (`opencode2` 1.1.0, `provider-codex` 0.1.0, …). A new adapter version can break
what worked (0.1.194 broke every OpenCode helper for six minutes, 2026-10-08). The table keeps one receipt per provider in use, adapter
version and capability (`answers` today): supported or not_supported; a version without a receipt is unproven.

- Every hour (`7 * * * *`) the sweep lists the providers in use (every project's settings plus the three base providers), reads each
  adapter's version, and probes each unproven one once with the drill's helper probe on the sandbox project.
- A failed probe opens the provider breaker for that provider and model: writers and helpers fall back to another provider until it answers
  again (the breaker's own half-open retry).
- `bb lane-pilot capabilities [--probe]` (exit 1 while any is not_supported), RPC `capability_table`.

The handoff capability registry derives each recipient's summary from its description or first prompt paragraph, retains its skills, and tokenizes its id, display name, summary, and skills for matching (`packages/handoff/src/registry.ts:21-46`). Jev provider metadata is centralized in `JEV_PROVIDERS`; project settings resolve unknown values to OpenLux, while a missing or unknown provider in a host call resolves to TypeSafe (`packages/jev/src/provider.ts:13-27`).

## How it works

1. The hourly sweep reads project provider/model settings, adds base providers, and reads installed provider adapter versions from BB (`src/rooms/capability/server/capability.ts:20-33`).
2. Providers without receipts for their current adapter version become due for probes; the probe uses a live sandbox run and tests answers before documentary and pause behavior (`src/rooms/capability/logic.ts:34-44`, `src/rooms/capability/server/capability.ts:45-58`).
3. A completed probe stores a versioned supported or not-supported receipt. Setup failures such as a missing live parent produce no receipt; an answers failure records not-supported and opens the provider breaker (`src/rooms/capability/server/capability.ts:59-72`).

| Probe result | State change | Effect |
|---|---|---|
| Supported | Saves a receipt for provider, adapter version, and capability. | The capability is proven for that adapter version (`src/rooms/capability/server/capability.ts:65-70`). |
| Unsupported answers | Saves not-supported and opens the breaker for the provider/model. | Provider selection can fall back (`src/rooms/capability/server/capability.ts:67-72`). |
| Setup failure | Does not save a receipt or open the breaker. | The provider remains unproven and can be probed again (`src/rooms/capability/server/capability.ts:59-64`). |
