---
title: Capability table of providers
type: component
created: 2026-10-23
updated: 2026-10-23
status: active
confidence: medium
tags: [sma, providers, adapters, probe]
sources:
  - src/rooms/capability/logic.ts
  - src/rooms/capability/server/capability.ts
---

# Capability table (SMA D2-7)

A provider is reached through an adapter, its BB plugin (`opencode2` 1.1.0, `provider-codex` 0.1.0, …). A new adapter version can break
what worked (0.1.194 broke every OpenCode helper for six minutes, 2026-10-08). The table keeps one receipt per provider in use, adapter
version and capability (`answers` today): supported or not_supported; a version without a receipt is unproven.

- Every hour (`7 * * * *`) the sweep lists the providers in use (every project's settings plus the three base providers), reads each
  adapter's version, and probes each unproven one once with the drill's helper probe on the sandbox project.
- A failed probe opens the provider breaker for that provider and model: writers and helpers fall back to another provider until it answers
  again (the breaker's own half-open retry).
- `bb lane-pilot capabilities [--probe]` (exit 1 while any is not_supported), RPC `capability_table`.
