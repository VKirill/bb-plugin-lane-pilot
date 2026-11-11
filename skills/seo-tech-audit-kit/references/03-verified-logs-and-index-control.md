---
title: "Verified log analysis and crawl/index policy"
status: draft
owner: drmax-books-finish
target_skill: seo-tech-diagnostics
source_pages: "Доказательное SEO 2026, book 1 ch.3 pp.30–61; book 2 ch.5 pp.343–345"
tags: [seo, engineering-reference, synthesized, private]
---

# Verified log analysis and crawl/index policy

> [!IMPORTANT] Scope
> This is an independently worded engineering synthesis of the local book, not a reproduction. Source interpretations of Google internals are hypotheses, not exposed metrics or proof of current ranking behavior. Examples and numerical settings are not universal rules. Operational checks added by the compiler are identified below.

## Data preparation

Use complete log windows with timezone, request path, status, timestamp and user agent; join a canonical URL inventory, sitemap membership and GSC status. Keep raw paths when normalizing parameters. Compiler safeguards: validate bot identity using an appropriate current verification mechanism, redact identifiers, document sampling and log-retention gaps. A claimed Googlebot user agent alone is insufficient.

## Procedure

1. Aggregate deterministically by day, bot, template, parameter pattern, status and final canonical. Count requests, unique URLs, error rates and crawl share. An LLM may explain the table; it must not estimate counts from a few displayed lines.
2. Identify repeated parameter families, traps, errors, old redirect chains and heavily crawled URLs without a useful task. Join impressions and index status before deciding that a URL is worthless.
3. Select the mechanism per purpose: keep a distinct useful page; consolidate equivalents; redirect permanently moved content; make a removal directive fetchable; or restrict wasteful crawling when appropriate. A crawl ban does not itself remove a URL from the index.
4. Align canonical, internal links, sitemap and redirect destination. Test a representative important URL, a duplicate, a forbidden route and all required CSS/JS resources before release.
5. Compare post-change logs and index observations with the baseline. Check that important content remains discoverable and that waste decreased without simply disappearing from the sampled data.

## Numbers and causal boundaries

The book's examples include more than five fetches/day without traffic and a 30–40% waste share. Treat these as triage examples, not global budgets. The 3–6 week quarantine scenario does not justify blocking a production URL blindly. GSC describes outcomes and logs describe server requests; neither directly reveals Google's full causal ranking pipeline.

## Completion

Produce a pattern-level diagnosis table with counts, joined evidence, chosen policy, affected URLs, reversible change specification and recheck date. Do not auto-deploy robots, noindex or redirects from an LLM-generated recommendation. Integration ends with a verified proposal and a separate release route.

## Source and integration

Source: Доказательное SEO 2026, book 1 ch.3 pp.30–61; book 2 ch.5 pp.343–345. Resolve physical PDF page N to `/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/raw_pages/page_NNN.txt`. Cross-check the named procedures in [the registry](/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/procedures-registry.json). This reference is ready for review and placement in `seo-tech-diagnostics`; no skill installation or live changes were performed.
