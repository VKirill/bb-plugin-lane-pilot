# Cohorts, anomalies and defect contours — reference

Source: «SEO Монстр 2027» ch5 pp. 454–468, ch1 pp. 47–51.

## Cohort setup details (pp. 454–457)

- Brand regex must cover Cyrillic, Latin and typo variants of the brand.
- Functional directories: catalog, product, services, branches, guides, glossary.
- Local query buckets (4): service + city/district; service with no place name; specialist + location; address/directions/phone.
- Signal smearing check: export every URL with impressions per commercial query.
- Striking-distance queue: commercial queries at positions 8–20, high impressions, low CTR.
- Four metrics per page class:
  1. primary business metric,
  2. leading GSC signals,
  3. transit micro-conversions (link clicks to catalog, calculator use, route clicks, add-to-cart, demo),
  4. defect metric.
- Weekly API export → BigQuery or CSV, joined with GA4 and CRM.

## Reading cohort patterns (decision rules, pp. 455–457)

| Pattern | Reading |
|---|---|
| Support article grows on off-topic queries, zero clicks to catalog | Topic drift, not success |
| Commercial page traffic up, conversion flat | Offer or price mismatch |
| Branch page grows only on address queries | Serves existing clients, not new demand |
| SKU traffic, no add-to-cart, quick SERP returns | Check price, stock, shipping |
| Help article read to end, no product transition | Dead end — add demo or product link |
| AI-cited guide loses ~25% clicks, booking transitions hold | Benign filtering |
| AI-cited guide, transitions at zero | Add a commercial gateway |
| Impression spike | Export top-100 queries, label target/adjacent/irrelevant |

Judge AI-cited pages by citation presence and mid-funnel transitions, not last click. Brand lift check horizon: 1 month (p. 457).

## Anomaly buckets A–D (pp. 460–461)

Noise floor: ignore pages under 100 impressions.

- **A — SERP-feature loss**: position top 5 ±1.0, impressions flat/up, CTR −20%+ → inspect SERP for AI Overviews, carousels, broken rich results. Warning: impressions +35% clicks flat, or CTR −25% at unchanged top-5.
- **B — ranking loss**: position −4+, impressions and clicks fall together → ranking loss or cannibalization.
- **C — on-page break**: clicks +15%+, conversions flat/falling → broken commercial route on the page.
- **D — reinforcement candidate**: position 8.0–18.0, high impressions, good historical conversion → internal links.

Extra checks: brand skew masking non-brand decline; mobile-only ~30% drops; main page −70% while an info article absorbs impressions (check both cocoon nodes before calling it a loss when AI answers prefer the support page).

Output per bucket: affected URLs with % and absolute deltas; each claim tagged *fact* or *cause hypothesis*; one concrete visual inspection target.

## Page-role mapping (pp. 459–460)

LLM assigns each URL a funnel role — discovery, mid-funnel selection, local terminal, commercial closing, brand-service — ignoring folder names. Cluster queries along behavioral axes (micro-task, doubt, failure mode). Human verifies the cluster sample.

## 10-vs-10 template comparison criteria (pp. 466–467)

Open 10 growing and 10 declining URLs of the same template side by side:

1. H1–H2 structure
2. First-screen price presence
3. Branch/author binding
4. Comparison table
5. CTA visibility
6. Incoming contextual links

Fix the recurring gap in the CMS template, not on single pages.

## Commercial fix examples (pp. 467–468)

- Clicks up, cart flat → decision attributes (dimensions, compatibility, install photos) on the first screen.
- Help pages, no trials → template download, limits table, demo button after step 2.
- Fix only the failing sub-cluster or pages, never the whole section by default.

## Hypothesis card — six scoring criteria (p. 48)

0–3 each: Pattern, Evidence, Alignment with Google's model, Scale, Business effect, Verifiability (max 18).

Five-question pre-launch filter — need ≥3 confident yes (p. 49); record a cancellation/falsification criterion before implementation.

Strong-example shape: "rebuild commercial template on 10 key landings, expect non-brand cluster growth" — named level, named fix, named metric (p. 48).

Reject: no URL list, no query list, no neighbor explanation. Hold: fewer than 3 filter yeses.

## Anti-patterns

- Flat site-wide charts; "visibility %" as a business KPI.
- Vague hypotheses ("rewrite service texts"), 5 concurrent changes in one window.
- Vague tasks ("boost E-E-A-T", "fix cards"), tasks bundled >10 edits.
- Rewriting copy for a mobile-only drop; section redesign for one broken block.
- Trusting folder names as page roles; mixing data-backed anomalies with meeting opinions.
