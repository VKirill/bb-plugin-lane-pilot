# Online tool page

## Functional online tool page: build and hardening (pp. 178-187)

**Trigger:** When building or auditing a calculator, converter, validator or repair tool

**Inputs:** top-10 intent check, widget, 2-3 sample presets, benchmarks on a reference dataset

### Steps

1. Confirm the tool intent. One Do operation per URL. Troubleshooting, pricing and security live on separate linked URLs.
2. SSR shell with label, aria-label, aria-live and noscript. Widget above the fold with drag-and-drop, paste, URL and cloud input, 2-3 sample presets, CLS under 0.1.
3. A limits card under the widget: quotas, size limits, price or credits, TLS, deletion timer, engine version, date last checked.
4. Free preview for non-deterministic tasks. Workflow chaining. A 1-click failure report or refund.
5. A preservation matrix (preserved, simplified, unsupported), your own benchmarks, formulas and standards, 2-3 worked examples or an error dictionary. The upload instruction appears exactly once.
6. Privacy by default and OWASP upload security: allowlist, MIME and magic bytes, zip-bomb guard, storage outside webroot, sandbox, short-TTL links.
7. UI state through POST, the History API or a hash, with a self-canonical. X-Robots-Tag noindex,nofollow on job, download and checkout URLs, without a robots.txt Disallow for them. Return 503 with Retry-After when the worker fails. WebApplication JSON-LD with one price and a nested softwareHelp CreativeWork.
8. Telemetry funnel: view, input, validation fail, processed, preview, download or fail.
9. Title formula: verb plus format conversion plus a limit that is met. For hreflang versions, localize units, currency, jurisdiction and data-storage law.

### Decision rules

- Never claim end-to-end encryption when the server decrypts files.
- Optimize for task completion, not dwell time.

### Thresholds

- CLS under 0.1
- Presets: 2-3
- Worked examples: 2-3
- Upload instruction: once

### Checklist

- Functional Tool Page Readiness, 8 nodes

### Anti-patterns

- Hidden paywalls or watermarks
- Instruction repeated 25 times
- Returning 200 while the backend is down

### Human checkpoints

- Run benchmarks
- Moderate reviews and failure escalations

### Tools

- Rich Results Test
- OWASP

### Feeds

- schema-jsonld-graph
- technical-indexing-audit

**Output:** Hardened tool page

**Done when:** All 8 nodes pass
