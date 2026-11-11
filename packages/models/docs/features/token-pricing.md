---
title: Token Pricing and Compatibility
type: component
created: 2026-11-08
updated: 2026-11-11
status: active
confidence: high
tags: [models, pricing, token-costs, provider-limits, picker-compatibility]
sources:
  - packages/models/src/model-prices.ts
  - packages/models/src/provider-limit.ts
  - packages/models/src/picker-compat.ts
  - packages/models/src/setting-value.ts
  - packages/models/tests/model-prices.test.ts
  - packages/models/tests/picker-compat.test.ts
---

# Token Pricing and Compatibility

TL;DR: Computes USD token costs from list prices, detects provider quota refusal messages, and reconciles reasoning efforts and service tiers.

## Purpose

The token pricing and compatibility subsystem provides financial calculation of model runs and validates UI model selections (packages/models/src/model-prices.ts:1-6).
It standardizes per-token rates across providers, catches provider refusals from CLI outputs before they can be misinterpreted as task completions, and normalizes user choices to supported capabilities (packages/models/src/model-prices.ts:30-42; packages/models/src/provider-limit.ts:1-3; packages/models/src/picker-compat.ts:1-21).

## How it works

1. Normalize model identifiers via `priceFor`: strip trailing context tags `[..]` and date snapshot suffixes `-YYYYMMDD` (packages/models/src/model-prices.ts:25-28).
2. Fetch per-million token rates from `MODEL_PRICES`: uncached input, cache read, 5-minute cache write, and output (packages/models/src/model-prices.ts:6-23).
3. Compute total run cost via `costUsd`: multiply usage counters by rates, divide by 1,000,000, and clamp to non-negative with `Math.max(0, usd)` (packages/models/src/model-prices.ts:30-41).
4. Parse raw process output with `providerLimitNotice`: trim whitespace, verify length <= 400 characters, match against `PROVIDER_LIMIT` regex, and return a normalized 200-character notice (packages/models/src/provider-limit.ts:9-13). The regex recognizes provider responses such as `unavailable (reset after …)` and `http 403 (reset after …)` (packages/models/src/provider-limit.ts:3).
5. Adjust reasoning levels via `compatibleReasoningLevel`: retain requested level when in `supported`, otherwise fall back to `defaultReasoningEffort` if supported, else return null (packages/models/src/picker-compat.ts:1-11).
6. Adjust service tiers via `compatibleServiceTier`: map requested tier ("default", "fast", or null) against `supported` tiers, ensuring standard speed defaults on providers advertising only "fast" (packages/models/src/picker-compat.ts:13-21).
7. Read setting values with `settingOff` (false, 0, "0", "off", "false", "no") and `settingOn` (true, 1, "1", "true", "on", "yes") (packages/models/src/setting-value.ts:2-5, :46-49). Read an `on|off` switch with `switchOn`: explicit `on` enables it, explicit `off` disables it, and any other or unset value uses membership in `SWITCHES_ON_BY_DEFAULT` (packages/models/src/setting-value.ts:11-19, :39-43). Read a word switch with `switchWord`: trim and lowercase the stored word, accept only its listed words, and use that key's fallback otherwise (packages/models/src/setting-value.ts:22-33).

### Model list prices (USD per 1M tokens)

| Model identifier | Input | Cache read | Cache write (5-min) | Output | Evidence |
|---|---|---|---|---|---|
| `claude-opus-5-5` | $4.00 | $0.20 | $5.00 | $20.00 | (packages/models/src/model-prices.ts:7) |
| `claude-opus-5` | $5.00 | $0.50 | $6.25 | $25.00 | (packages/models/src/model-prices.ts:8) |
| `claude-sonnet-5` | $2.00 | $0.20 | $2.50 | $10.00 | (packages/models/src/model-prices.ts:9) |
| `claude-sonnet-5-5` | $2.00 | $0.20 | $2.50 | $10.00 | (packages/models/src/model-prices.ts:10) |
| `claude-fable-5-1` | $10.00 | $0.25 | $12.50 | $50.00 | (packages/models/src/model-prices.ts:11) |
| `claude-haiku-4-5` | $1.00 | $0.10 | $1.25 | $5.00 | (packages/models/src/model-prices.ts:12) |
| `claude-haiku-5-5` | $0.10 | $0.01 | $0.125 | $0.50 | (packages/models/src/model-prices.ts:14) |
| `gpt-6-astra` | $10.00 | $1.00 | $12.50 | $50.00 | (packages/models/src/model-prices.ts:15) |
| `gpt-6.1-sol` | $2.00 | $0.10 | $2.50 | $10.00 | (packages/models/src/model-prices.ts:16) |
| `gpt-6.1-terra` | $1.00 | $0.05 | $1.25 | $5.00 | (packages/models/src/model-prices.ts:17) |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.50 | (packages/models/src/model-prices.ts:18) |
| `gpt-6-sol` | $2.00 | $0.20 | $2.50 | $10.00 | (packages/models/src/model-prices.ts:19) |
| `gpt-5.6-sol` | $4.00 | $0.40 | $5.00 | $20.00 | (packages/models/src/model-prices.ts:20) |
| `gpt-5.6-terra` | $2.00 | $0.20 | $2.50 | $12.00 | (packages/models/src/model-prices.ts:21) |
| `gpt-5.6-luna` | $0.20 | $0.02 | $0.25 | $1.20 | (packages/models/src/model-prices.ts:22) |

### Failures and unhandled outputs

| Condition | Detected symptom | Result | Evidence |
|---|---|---|---|
| Unknown model | Model name not found in `MODEL_PRICES` after suffix stripping | `priceFor` and `costUsd` return `null` | (packages/models/src/model-prices.ts:27, :34) |
| Long output text | Output length > 400 characters matching limit words | `providerLimitNotice` returns `null` (not a quota notice) | (packages/models/src/provider-limit.ts:11) |
| Non-limit text | Output text does not match `PROVIDER_LIMIT` regex | `providerLimitNotice` returns `null` | (packages/models/src/provider-limit.ts:11) |
| Reset-time refusal | Provider response contains `unavailable (reset after …)` or `http 403 (reset after …)` | `PROVIDER_LIMIT` recognizes these forms | (packages/models/src/provider-limit.ts:3) |
| Unsupported reasoning | Requested level not in `supported` and default unsupported | `compatibleReasoningLevel` returns `null` | (packages/models/src/picker-compat.ts:10) |

## Business rules

- Non-negative cost invariant: `costUsd` never produces negative numbers; zero usage yields zero USD (packages/models/src/model-prices.ts:30-41).
- Distinct cache write pricing: 5-minute cache writes have separate rates from uncached inputs and cache reads (packages/models/src/model-prices.ts:6, :35-40).
- Rate limit false-positive protection: Legitimate reports that mention rate-limit files or tests exceed 400 characters; `providerLimitNotice` requires <= 400 characters to treat the output as a provider refusal (packages/models/src/provider-limit.ts:9-12).
- Fast-only provider normal speed: Providers that only list "fast" still run models at normal speed ("default") (packages/models/src/picker-compat.ts:17-18).
- Boolean value parsing: `settingOff` considers false, 0, "0", "off", "false", and "no" disabled; `settingOn` considers true, 1, "1", "true", "on", and "yes" enabled (packages/models/src/setting-value.ts:2-5, :46-54).
- Switch defaults: `switchOn` recognizes only the trimmed, lowercased words "on" and "off" as explicit values; all other values use the shared default-on key set (packages/models/src/setting-value.ts:39-43), whose keys are listed in `SWITCHES_ON_BY_DEFAULT` (packages/models/src/setting-value.ts:11-19). `switchWord` recognizes only the words listed for its key and falls back for an unset or unrecognized value (packages/models/src/setting-value.ts:26-38).

## Public API

| Export | Purpose | Evidence |
|---|---|---|
| `MODEL_PRICES` | Price table for standard list rates per 1M tokens | (packages/models/src/model-prices.ts:6-23) |
| `PRICES_CHECKED_AT` | Static version tag indicating price table verification | (packages/models/src/model-prices.ts:1) |
| `priceFor` | Resolves `ModelPrice` for a model, stripping suffixes | (packages/models/src/model-prices.ts:25-28) |
| `costUsd` | Calculates total USD cost for a token usage breakdown | (packages/models/src/model-prices.ts:30-42) |
| `providerLimitNotice` | Detects provider refusal notices in short command outputs | (packages/models/src/provider-limit.ts:9-13) |
| `compatibleReasoningLevel` | Maps requested reasoning effort to supported model efforts | (packages/models/src/picker-compat.ts:1-11) |
| `compatibleServiceTier` | Maps requested service tier to supported provider tiers | (packages/models/src/picker-compat.ts:13-21) |
| `SWITCHES_ON_BY_DEFAULT` | Keys whose unset or unrecognized on/off switch value resolves to on | (packages/models/src/setting-value.ts:11-19) |
| `SWITCH_WORD_DEFAULTS` | Fallback word and accepted words for each word switch | (packages/models/src/setting-value.ts:22-26) |
| `switchOn` | Resolves an on/off switch from its stored word or shared default set | (packages/models/src/setting-value.ts:39-43) |
| `switchWord` | Resolves a word switch from its accepted words or configured fallback | (packages/models/src/setting-value.ts:28-33) |
| `settingOff` | Evaluates whether a configuration value represents off | (packages/models/src/setting-value.ts:2-5) |
| `settingOn` | Evaluates whether a configuration value represents on | (packages/models/src/setting-value.ts:46-54) |

## Gotchas

For implementation traps regarding unknown model returns, suffix stripping, and provider limit character caps, see [Gotchas](../gotchas.md).

<!-- lane-pilot:backlinks -->
## Referenced by

- [Models Workspace — Overview](../overview.md)
