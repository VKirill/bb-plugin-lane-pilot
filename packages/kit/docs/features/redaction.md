---
title: Secret redaction and credential protection
type: component
created: 2026-11-08
updated: 2026-11-11
status: active
confidence: high
tags: [kit, redaction, security, credentials]
sources:
  - packages/kit/src/redact.ts
  - packages/kit/src/secret-files.ts
  - packages/kit/src/index.ts
  - packages/kit/src/output-excerpt.ts
  - packages/kit/package.json
  - packages/kit/tests/redact.test.ts
  - src/rooms/secrets/server/secrets.ts
  - src/rooms/errands/episode-enrich.ts
---

# Secret redaction and credential protection

TL;DR: The redaction module expands fetched secrets into printable forms for value-based masking, remembers fetched values in process memory, masks selected credential shapes in text, and identifies secret-looking repository paths (`packages/kit/src/redact.ts:15-32`, `packages/kit/src/redact.ts:60-85`, `packages/kit/src/redact.ts:106-130`, `packages/kit/src/secret-files.ts:6-16`).

## Purpose

Sensitive configuration values and credentials fetched from environment catalogs must never leak into persistent artifacts or check reports (`packages/kit/src/redact.ts:1-6`).

The package also exports `secretPathHit`, which classifies a repo-relative path by a secret directory or filename (`packages/kit/src/secret-files.ts:1-16`, `packages/kit/src/index.ts:5`).

The value-based helpers expand fetched secrets into common serializations via `secretNeedles` (`packages/kit/src/redact.ts:14-32`) and replace them with `MASK` (`packages/kit/src/redact.ts:7`, `packages/kit/src/redact.ts:39-43`). `maskCredentials` also masks private-key blocks, selected token shapes, Bearer values and uppercase credential assignments; it reports whether it changed the text (`packages/kit/src/redact.ts:114-123`, `packages/kit/src/redact.ts:131-135`).

## How it works

1. **Needle expansion:** `secretNeedles` accepts an iterable of secret strings. Any value shorter than `MIN_SECRET_LENGTH` (4 characters) is skipped (`packages/kit/src/redact.ts:17-19`). For every valid secret, it generates variants:
   - Verbatim plain string (`packages/kit/src/redact.ts:20`).
   - JSON-escaped string without wrapping quotes (`packages/kit/src/redact.ts:21`).
   - URL-encoded string via `encodeURIComponent` (`packages/kit/src/redact.ts:22`).
   - Standard base64 representation (`packages/kit/src/redact.ts:24`).
   - Base64 representation without trailing `=` padding (`packages/kit/src/redact.ts:25`).
   - URL-safe base64 (`base64url`) (`packages/kit/src/redact.ts:26`).
   - Multi-line secrets stripped of carriage returns and line feeds (`packages/kit/src/redact.ts:28`).
   - Individual trimmed lines from multi-line values having at least 8 characters (`packages/kit/src/redact.ts:29`).
2. **Regex compilation:** Needles are sorted by length descending so longer needles match before substrings (`packages/kit/src/redact.ts:32`). The strings are escaped and combined into a global regular expression (`packages/kit/src/redact.ts:35-37`).
3. **Targeted text redaction:** `redactSecrets(text, values)` applies the compiled pattern to substitute each needle with `MASK` (`"***"`) (`packages/kit/src/redact.ts:7`, `packages/kit/src/redact.ts:40-43`).
4. **Env catalog extraction:** `secretStrings(record)` inspects catalog records, returning `record.value` and nested `record.access` fields (`password`, `privateKey`, `passphrase`) (`packages/kit/src/redact.ts:46-58`).
5. **Process-level secret memory:** `registerSecrets` populates an in-memory `Set` of known secrets (`packages/kit/src/redact.ts:61`, `packages/kit/src/redact.ts:66-73`). When registered entries exceed `MAX_KNOWN` (2000), older items are deleted FIFO (`packages/kit/src/redact.ts:10`, `packages/kit/src/redact.ts:71`).
6. **Global and deep masking:** `redactKnown` redacts text using the cached compiled pattern from all registered secrets, recompiling when dirty (`packages/kit/src/redact.ts:81-85`). `redactKnownDeep` recursively traverses objects and arrays to sanitize string values while leaving dictionary keys unchanged (`packages/kit/src/redact.ts:88-96`).
7. **Credential-shaped text masking:** `maskCredentials` applies the shape table, uppercase assignment rule and remembered-secret masking (`packages/kit/src/redact.ts:114-123`, `packages/kit/src/redact.ts:131-135`). `withoutCredentials` additionally applies the keyword and post-email patterns (`packages/kit/src/redact.ts:102-104`, `packages/kit/src/redact.ts:143-147`).
8. **Prompt credential scrubbing:** `withoutCredentials` replaces a value after password/token keywords or a credential-shaped word after an email, and masks the shared token shapes with `CREDENTIAL_MASK` (`packages/kit/src/redact.ts:99-104`, `packages/kit/src/redact.ts:143-147`).
9. **Selection token cleanup:** `withoutSelectionMarkers` strips UI session tokens formatted as `[lane-pilot-selection:<uuid>]` (`packages/kit/src/redact.ts:149-150`).
10. **Secret-path classification:** `secretPathHit` normalizes Windows separators, checks every path segment against the secret-directory set, then checks only the final segment against secret-name patterns (`packages/kit/src/secret-files.ts:6-16`). It returns `{ dir }`, `{ name: true }`, or `null`.

### Modes, variants, and thresholds

| Constant or threshold | Value | Purpose | Evidence |
|---|---|---|---|
| `MASK` | `"***"` | Replacement string for sensitive values | `packages/kit/src/redact.ts:7` |
| `MIN_SECRET_LENGTH` | `4` characters | Minimum length required for a secret to be registered or expanded | `packages/kit/src/redact.ts:9` |
| `MAX_KNOWN` | `2000` items | In-memory cap for known process secrets; oldest entries evicted on overflow | `packages/kit/src/redact.ts:10`, `packages/kit/src/redact.ts:71` |
| Multi-line line threshold | `8` characters | Minimum length for a line inside a multi-line secret to be isolated as an independent needle | `packages/kit/src/redact.ts:29` |
| `CREDENTIAL_MASK` | `"[password hidden: it is in the owner's message; the PM keeps it in Env Catalog]"` | Placeholder inserted for prompt credentials | `packages/kit/src/redact.ts:99` |
| `maskCredentials` default mask | `MASK` (`"***"`) | Replaces selected credential shapes and registered secret values; returns `{ text, masked }` | `packages/kit/src/redact.ts:131-135` |
| `secretPathHit` | Secret directory, secret filename, or no match | Returns `{ dir }`, `{ name: true }`, or `null` for a repo-relative path | `packages/kit/src/secret-files.ts:6-16` |

### Failures

The redaction functions operate defensively without throwing runtime exceptions:
- Values shorter than `MIN_SECRET_LENGTH` are ignored by `secretNeedles` (`packages/kit/src/redact.ts:17-19`) and `registerSecrets` (`packages/kit/src/redact.ts:66-68`).
- Lone surrogate strings that cannot be URI-encoded fail silently inside a `try/catch` block during URL expansion (`packages/kit/src/redact.ts:22`).
- Empty inputs or empty secret sets return the source text or structure unmodified (`packages/kit/src/redact.ts:42`, `packages/kit/src/redact.ts:82`, `packages/kit/src/redact.ts:89`).

## Business rules

- **Minimum secret length:** Values with fewer than 4 characters are never masked (`packages/kit/src/redact.ts:9`, `packages/kit/src/redact.ts:19`). This prevents short words like `"ok"` or `"1"` from corrupting text.
- **Ordered replacement:** Needles are sorted by descending string length prior to regex construction to ensure longer matching phrases take precedence over substrings (`packages/kit/src/redact.ts:32`).
- **Memory eviction ceiling:** The in-memory known secret cache is bounded at 2000 entries; additions exceeding 2000 discard the oldest inserted secret (`packages/kit/src/redact.ts:10`, `packages/kit/src/redact.ts:71`).
- **Deep sanitization key safety:** `redactKnownDeep` inspects and masks string values within nested objects and arrays, but object property keys remain untouched (`packages/kit/src/redact.ts:93`).
- **Idempotent credential masking:** `withoutCredentials` splits on `CREDENTIAL_MASK` before running regular expressions, ensuring repeated calls do not double-mask text (`packages/kit/src/redact.ts:143-147`).
- **Masking is shape-limited:** `maskCredentials` recognizes private-key blocks, listed token prefixes, Bearer tokens and uppercase assignments, then remembered values; keyword and email-adjacent prompt handling belongs to `withoutCredentials` (`packages/kit/src/redact.ts:114-123`, `packages/kit/src/redact.ts:131-147`).
- **Path checks use whole segments and basenames:** `secretPathHit` matches `.git`, `.ssh`, `.aws`, and `.gnupg` as path segments; filename patterns apply only to the final segment, so `keyboard.ts` does not match the `.key` suffix rule (`packages/kit/src/secret-files.ts:6-16`).

## Public API

| Export | Type | Purpose | Evidence |
|---|---|---|---|
| `MASK` | `const string` | Redaction mask string (`"***"`) | `packages/kit/src/redact.ts:7` |
| `MIN_SECRET_LENGTH` | `const number` | Minimum secret length threshold (`4`) | `packages/kit/src/redact.ts:9` |
| `secretNeedles` | `function` | Expands raw secrets into serialised needle variants | `packages/kit/src/redact.ts:15-34` |
| `redactSecrets` | `function` | Redacts an explicit set of secrets from text | `packages/kit/src/redact.ts:40-45` |
| `secretStrings` | `function` | Extracts secret fields from environment catalog records | `packages/kit/src/redact.ts:46-58` |
| `registerSecrets` | `function` | Registers secret strings into the global memory registry | `packages/kit/src/redact.ts:66-73` |
| `forgetSecrets` | `function` | Clears all registered secrets and resets cached patterns | `packages/kit/src/redact.ts:76` |
| `knownSecretCount` | `function` | Returns the number of currently remembered secrets | `packages/kit/src/redact.ts:78-80` |
| `redactKnown` | `function` | Redacts all registered secrets from a text string | `packages/kit/src/redact.ts:81-87` |
| `redactKnownDeep` | `function` | Recursively redacts registered secrets within structured objects | `packages/kit/src/redact.ts:88-96` |
| `maskCredentials` | `function` | Masks selected credential shapes and registered secrets; returns text and a changed flag | `packages/kit/src/redact.ts:131-135` |
| `CREDENTIAL_SHAPE_PATTERNS` | `readonly RegExp[]` | Exposes the shared private-key, token-shape, and Bearer patterns without the uppercase assignment rule | `packages/kit/src/redact.ts:114-119`, `packages/kit/src/redact.ts:126-128` |
| `CREDENTIAL_MASK` | `const string` | Owner credential replacement text | `packages/kit/src/redact.ts:99` |
| `withoutCredentials` | `function` | Strips plain-text credentials from owner messages | `packages/kit/src/redact.ts:143-147` |
| `withoutSelectionMarkers` | `function` | Removes UI selection UUID markers from text | `packages/kit/src/redact.ts:149-150` |
| `SECRET_DIRS` | `Set<string>` | Secret-bearing directory segment names used by `secretPathHit` (`packages/kit/src/secret-files.ts:6-7`) |
| `SECRET_NAMES` | `RegExp[]` | Secret-looking filename patterns used by `secretPathHit` (`packages/kit/src/secret-files.ts:8-10`) |
| `secretPathHit` | `function` | Classifies a repo-relative path by secret directory or basename (`packages/kit/src/secret-files.ts:11-16`) |

## Gotchas

- **Eviction under heavy churn:** If more than 2000 secrets are registered during a daemon process lifetime, the oldest secret is dropped from memory (`packages/kit/src/redact.ts:10`, `packages/kit/src/redact.ts:71`). Subsequent `redactKnown` calls will not mask that evicted secret. See [Kit gotchas](../gotchas.md).
- **Sub-4 character secrets:** Secrets containing 1, 2, or 3 characters are ignored by design (`packages/kit/src/redact.ts:9`, `packages/kit/src/redact.ts:19`).
- **In-memory lifecycle:** Registered secrets reside exclusively in RAM (`packages/kit/src/redact.ts:61`). Process restarts clear the registry unless secrets are re-registered.

<!-- lane-pilot:backlinks -->
## Referenced by

- [Kit gotchas](../gotchas.md)
- [Kit workspace overview](../overview.md)
