---
name: seo-page-templates
description: >-
  Page-type build procedures and verification checklists from «SEO Монстр 2027» ch.3-5: homepage, category, product card, service, article, local landing, online tool, selections/brand/comparison, YMYL operational layout; semantic tables, extractable snippet units, JSON-LD @graph and media markup. Use when: тип страницы, шаблон страницы, page template, карточка товара, категория, посадочная, YMYL, JSON-LD, сниппет. SKIP: site-level hierarchy (→topical-graph-architect); rollout mechanics (→seo-release-protocol).
---

# SEO Page Templates

Build and verify a page of a known type. Each reference file holds the zone-by-zone spec, the mandatory blocks and the verification checklist (with page refs).

## When to use

- Building or auditing a page inside a cocoon, a template matrix or a refresh run
- Choosing the template that matches the SERP intent for the page's job
- Assembling shared blocks: entity passport, answer-first content, semantic tables, extractable units, media, JSON-LD

## Pick the page-type spec

| Page type | Reference |
|---|---|
| Homepage (brand verification, link-weight routing) | [homepage](references/homepage.md) |
| Category listing (5-layer build, L1 routing) | [category](references/category.md) |
| Product card / PDP (variants, out-of-stock, machine-readable layer) | [product](references/product.md) |
| Service page (commercial standard, proof layer, hierarchy) | [service](references/service.md) |
| Informational article | [informational](references/informational.md) |
| Local / geo landing | [local-landing](references/local-landing.md) |
| Online tool | [online-tool](references/online-tool.md) |
| Selection, brand node, comparison page | [commercial-special](references/commercial-special.md) |
| YMYL operational layout + experience packaging | [ymyl](references/ymyl.md) |

## Shared assembly (every page)

[shared-blocks](references/shared-blocks.md) — in order:

1. Entity passport and focus formula (pp. 157-160).
2. Main content assembly: core first, answer-first modules, structured formats (pp. 198-206).
3. Semantic HTML tables for comparisons/specs (pp. 200-206).
4. Extractable units for Featured Snippets and AI citations (pp. 217-236).
5. Media: image markup, delivery, hero, slot-based gallery alts (pp. 237-248).
6. JSON-LD @graph: content-first design, validation, rollout (pp. 249-261).
7. Pre-release utility and content gate (pp. 418-427).

## Core decision rules

- Template follows SERP intent: the dominant page type in the top results sets the format; mixing intents on one URL loses to the focused competitor (pp. 157-158).
- Every page type has its own verification checklist — a page is done only when its checklist passes, not when text is written (pp. 262-276).
- Commercial pages without a proof layer (tagged cases, verified reviews, answer-first Q&A) are incomplete (pp. 353-366).
- YMYL pages route through the risk tier first: cost of error sets the production mode, claim passports and dual review (pp. 418-427).
- Extractable units are self-contained and citable out of context; a fragment that only works inside the article is rewritten (pp. 222-236).

## Output contract

The node returns: the filled page spec for its type (zones, blocks, markup), the media and JSON-LD payloads, and the passed type checklist — or a list of failed checklist items routed back to writing.

## Called by

- `seo-page` graph (page_type spec for drafting and QA)
- `seo-brief` sub-graph (template selection inside the brief)
- `seo-template-scale` graph (template passports for catalog/geo matrices)

## Sources

«SEO Монстр 2027» ch. 3 (pp. 157-276), ch. 4 (pp. 333-378), ch. 5 (pp. 393-436). Paraphrased with page references; details in references/.

## Wave-2 Distilled References

- `references/rag-chunking-semantic-search-and-landing-ecom.md` — operational playbook and thresholds.
- `references/agent-readiness-and-content-signals.md` — operational playbook and thresholds.
- `references/05-onpage-evidence-and-title-contract.md` — evidence-led on-page, title/SERP alignment, and draft verification contract.
- `references/04-brief-draft-and-qc-gates.md` — brief/draft QC gates, Barbara Minto (*Pyramid Principle*: `SCQA`, `Answer-First` H2 leads, `MECE`), and William Zinsser (*On Writing Well*: clutter stripping, active verbs, 4 Unities).
- Cross-skill internal linking & GEO/RAG evidence: open `seo-ai-visibility` (`06-internal-linking-and-geo-rag-evidence.md`) for contextual hub-spoke anchor rules, EAV tables, and self-contained RAG passage blocks.
