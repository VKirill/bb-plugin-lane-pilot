---
title: "Internal linking architecture and GEO/RAG extractability"
status: active
owner: drmax-books-finish
target_skill: seo-ai-visibility
source_pages: "Доказательное SEO 2026, book 1 ch.9 pp.121–131; book 2 ch.6 pp.398–404"
tags: [seo, geo, rag, internal-linking, engineering-reference, synthesized, private]
---

# Internal linking architecture and GEO/RAG extractability

> [!IMPORTANT] Scope
> Independently worded engineering synthesis of *Доказательное SEO 2026* (Book 1 Ch.9 and Book 2 Ch.6). Interpretations of internal search-engine or LLM retrieval pipelines are working engineering models, not exposed public APIs or deterministic ranking guarantees.

## Trigger and inputs

Open when designing hub-and-spoke link graphs for cocoons, diagnosing «crawled/indexed but unstuck at positions 15–50 or uncited in AI answers», or preparing content orders from `seo-ai-visibility` (`seo-page-refresh`, `code_task`). Require a crawl link-graph export (`source -> target`, anchor, DOM zone, status), XML sitemap inventory, verified bot logs (where available), and dated multi-run AI panel outputs (`ai_vis_score.py`).

## Part 1 — Evidence-based internal linking architecture (Book 1 Ch.9)

1. **Contextual Hub-and-Spoke Weight Flow:**
   - Links placed inside main-content editorial prose (`<main>` / `<article>`) carry substantially clearer topical and task-transition signal than sitewide header, mega-menu, sidebar, or footer chrome.
   - Route authority deliberately along task topology: **Pillar Hub ↔ Supporting Sub-Hubs → Commercial Acceptors (Category / Service / Product / Tool)**, with upward breadcrumb/hub return links closing every cluster loop.
   - Do not dilute high-authority hubs with dozens of unrelated «read also» cards; restrict contextual outlinks to pages that genuinely advance the reader's next sub-question or purchase step.
2. **Anchor Information Scent & Natural Diversity (Zero Exact-Match Spam):**
   - Write anchors with high **information scent**: the reader and retriever must know the exact entity and task waiting at the destination URL without clicking blindly (never use «тут», «подробнее», «click here», «read more»).
   - Vary phrasing naturally across linking pages using task-specific partial phrases, entity-plus-attribute labels, and natural morphology. Mechanical 100% identical exact-match commercial anchors across hundreds of internal spokes act as an over-optimization footprint rather than an authority multiplier.
3. **Orphan, Dead-End, and Redirect-Sink Elimination:**
   - Cross-join three inventories: **(A) Crawler rendered `<a href>` graph**, **(B) Clean XML sitemap**, and **(C) 30-day GSC / verified server-log hits**.
   - **Orphan URL** (present in sitemap or DB, `0` contextual inlinks from crawlable hubs): wire into ≥2 relevant parent/sibling hubs within ≤3–4 clicks of primary entry nodes, or prune/consolidate if zero task demand exists.
   - **Dead-End Spoke** (informational article receiving traffic with `0` contextual links toward commercial or next-step hubs): add 1–3 task-matched transition blocks above the fold or right after the primary answer table.
   - **Link Sinks**: replace internal links pointing to `301/302` hops, `404/410`, parameter duplicates, or `noindex` pages with direct `200 OK` self-canonical destinations.

## Part 2 — Evidence-based GEO / AI Search & RAG extractability (Book 2 Ch.6)

Generative search systems (Google AI Overviews, Yandex Alice AI, Perplexity, ChatGPT Search) retrieve candidate URLs through hybrid lexical/dense search and feed **chunked passages** (`~100–250` words or table/list nodes) into a synthesis context window. Pages fail citation when facts are smeared across multi-screen narrative prose.

1. **Self-Contained Answer Passages (`Chunk Independence`):**
   - Open every `H2`/`H3` question-bearing section with a standalone 40–80 word paragraph that explicitly names the **subject entity**, **condition/scope**, and **direct answer**.
   - Eliminate context-dependent pronouns («это решение», «данный метод», «such systems») in the first two sentences of any section so a retrieved chunk remains unambiguous out of page context.
2. **Explicit Entity–Attribute–Value (`EAV`) & Structured Table Layer:**
   - Express specs, pricing tiers, limits, legal thresholds, and feature comparisons as explicit `Entity -> Attribute -> Value (+ unit, currency, region, date)` statements backed by semantic HTML `<table>`, `<dl>`, or ordered `<ol>` steps.
   - Keep visible numbers, entity names, and `sameAs` identifiers 100% consistent with page JSON-LD (`Product`, `Service`, `FAQPage`, `Organization`, `Person`) and `BrandCore`.
3. **Citation Groundability & Primary Evidence:**
   - Generative answer rankers favor passages carrying verifiable grounding: dated measurements, explicit sample sizes, named standards/laws, original test methodology, and disclosed boundaries (when a method does *not* apply).
   - Unattributed copycat rewrites of existing top-10 articles offer zero marginal information gain (`Information Gain`) to a RAG synthesizer and are routinely collapsed or omitted from citations.

## Epistemic boundaries & forbidden overclaims

1. **No Deterministic LLM Rank Scores:** Generative answers are stochastic and context-sensitive across time, geo, user history, and prompt phrasing. Never promise guaranteed AI #1 placement or report visibility gains from a single query run; require `>= 2` dated runs across the locked question panel (`G3` gate in `seo-ai-visibility`).
2. **No Leaked Warehouse Attributes as Live Metrics:** References in SEO literature to leaked internal Google warehouse fields (`Goldmine`, `siteRadius`, `contentEffort`, `navboost`, `authorReputationScore`) are conceptual hypotheses about system architecture — **never** present them as measurable API scores or audit numbers.
3. **Crawl & Render Prerequisite:** Neither `llms.txt` nor JSON-LD rescues a page whose main answer requires client-only JS execution blocked or skipped by AI/search fetchers; verify SSR HTML text parity first (`agent_ready_audit.py`).

## Output and hand-off contract

Produce an evidence table joining `(URL, cluster, contextual_inlinks, click_depth, anchor_diversity, ssr_answer_block_ok, eav_table_ok, ai_presence_share, ai_citation_share)` and emit bounded orders:
- Missing hub-spoke links or orphan commercial acceptors → `seo-cocoon` / `code_task` template link block;
- «Visible in SERP top-10 but uncited in AI answers» → `seo-page-refresh` order to add self-contained `Answer-First` passages, `EAV` comparison tables, and dated primary proof;
- Third-party corroboration gap on entity comparisons → `seo-mentions` / `seo-linkbuilding-method` (gated by `owner_go == approve`).

## Source and integration

Source: *Доказательное SEO 2026*, Book 1 Ch.9 (pp.121–131) and Book 2 Ch.6 (pp.398–404). Resolve physical PDF page N to `/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/raw_pages/page_NNN.txt` and cross-check [procedures-registry.json](/home/ubuntu/specialist-curriculum/_distilled/drmax-dokazatelnoe-seo-2026/procedures-registry.json). Cross-linked in `seo-ai-visibility`, `seo-drmax-orchestrator`, and `seo-page-templates`. Active reference installed in `seo-ai-visibility`.
