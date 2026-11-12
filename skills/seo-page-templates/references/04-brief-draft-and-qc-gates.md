---
title: "Brief, Pyramid outline, prose clarity and quality-control gates"
status: active
owner: drmax-books-finish
target_skill: seo-page-templates
source_pages: "Промптоведение v1.5 pp.23–30, modules 13, 17, 23–24; Barbara Minto Pyramid Principle; William Zinsser On Writing Well"
tags: [seo, prompt-architecture, pyramid-principle, prose-qc, synthesized, private]
---

# Brief, Pyramid outline, prose clarity and quality-control gates

> [!NOTE] Provenance
> Independently worded engineering synthesis combining *Промптоведение для SEO-стратегов 2026 v1.5*, Barbara Minto's *The Pyramid Principle*, and William Zinsser's *On Writing Well*. Field names and acceptance gates are operational conventions; model outputs remain hypotheses until verified against live SERP and user outcomes.

## Brief gate

Require a verified user task, audience segment, locale, journey stage, chosen page role, source packet, trust requirements, existing URL decision and business outcome. Format Fit selects how the answer should work; it does not automatically imply a long article. Commercial Intent connects a task to an actual service or product rather than adding aggressive wording.

## Structural outline gate — Barbara Minto (*The Pyramid Principle*)

1. **`SCQA` Lead Framing (3–5 sentences max):** Open the page without throat-clearing preamble:
   - *Situation*: the verified operational context the reader already recognizes;
   - *Complication*: the concrete cost, risk, or bottleneck that broke the status quo;
   - *Question*: the exact decision or technical problem this page resolves;
   - *Answer*: the governing recommendation, price/time range, or selection rule up front.
2. **`Answer-First` Governing Thought under every `H2` / `H3`:** Immediately below every section heading, place a 1–2 sentence self-contained governing conclusion before listing arguments, steps, or edge cases. Readers skimming on mobile, Featured Snippet extractors, and RAG passage retrievers must get the direct answer in the first 40–60 words of each section.
3. **`MECE` Sub-Sections (Mutually Exclusive, Collectively Exhaustive):** Sibling `H3` blocks, comparison columns, or checklist items under one `H2` must partition the topic cleanly (2–5 grouped pillars ordered by chronology, structural component, or decision weight) with zero overlapping repetition across sibling sections.

## Prose clarity & clutter gate — William Zinsser (*On Writing Well*)

1. **Ruthless Clutter Stripping:** Delete empty lead-ins («Важно отметить, что», «Не секрет, что», «В современном мире», «It is worth noting that»), pompous qualifiers, and stacked abstract nouns. Every sentence must add a new verifiable fact, threshold, constraint, or action step.
2. **Active Verbs & Concrete Nouns:** Replace passive nominalizations («осуществляется проведение дефектовки», «производится оптимизация») with direct subject–verb–object clauses naming who performs what step, on what equipment/input, and within what measurable time or tolerance.
3. **Zinsser's Four Unities Check:** Before a draft leaves QC, confirm unbroken consistency across:
   - *Unity of Pronoun*: keep one address stance («вы» + concrete company subject) without drifting into third-person bureaucracy mid-page;
   - *Unity of Tense*: present tense for invariant rules and specs, past tense strictly for dated case measurements;
   - *Unity of Mood/Tone*: calm, factual practitioner authority from hero to FAQ (never alternating ad hype with pasted legal jargon);
   - *Unity of Audience Level*: calibrate depth to one target buyer/operator competence level from H1 to CTA.

## Production gates

1. **Input readiness:** validate project facts and document missing data. If the business cannot serve the locale or support the page promise, return that dependency before drafting.
2. **Brief readiness:** connect each required block to a user decision, `MECE` outline slot, and primary evidence. State what the page must not claim, which facts change over time, and who verifies sensitive statements.
3. **Draft fidelity:** verify every material claim against the source packet. Preserve limitations and epistemic status; never promote an upstream hypothesis into an asserted fact.
4. **Functional & structural quality:** enforce `SCQA` intro, `Answer-First` H2 leads, `MECE` section boundaries, Zinsser clutter/unity checks, valid link destinations, and visible-to-JSON-LD parity.
5. **Release proposal:** return accepted content, unresolved issues, owner/reviewer decisions, and a measurable follow-up plan. Passing a prompt critic does not publish the page or prove search performance.

## Synthesized QC artifact

For each defect, save location, violated requirement (`FACT | MECE | ANSWER_FIRST | CLUTTER | UNITY | SCHEMA`), evidence, severity, fix owner, and acceptance check. Hard failures include unsupported facts, invented first-hand experience, fake sources, non-existent URLs, contradictory offers, and unreviewed consequential claims. Soft prose polish never masks a factual failure.

## Evaluation limits

Use a fixed set of real examples and difficult edge cases when revising templates. Preserve prompt, model, and source versions. An LLM judge can screen structure and clutter but requires human calibration on domain truth; decisions to scale follow measured cohort outcomes rather than word count or critic scores.

## Sources and placement

Source: DrMax, *Промптоведение для SEO-стратегов 2026 v1.5* (method pp.23–30; modules 13, 17, 23–24; appendices pp.178–192), synthesized with Barbara Minto (*The Pyramid Principle*) and William Zinsser (*On Writing Well*). Physical page N maps to `/home/ubuntu/specialist-curriculum/_distilled/drmax-promptovedenie-2026/raw_pages/page_NNN.txt`; see [the catalog](/home/ubuntu/specialist-curriculum/_distilled/drmax-promptovedenie-2026/prompts-catalog.json). Active reference installed in `seo-page-templates`.
