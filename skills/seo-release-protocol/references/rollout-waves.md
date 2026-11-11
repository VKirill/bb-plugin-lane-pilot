# Cohort, batch and wave rollouts

## Safe mass template rollout: cohorts, override fields, 5 layers, split test (pp. 262-273)

**Trigger:** When rolling out new templates or batch meta formulas on a live site

**Inputs:** 90-day GSC data per URL (positions, CTR, impressions, indexing, snippets, AI citations), 90-day GA4 data, CMS schema

### Steps

1. Segment the URLs. Cohort 1, protected: top 1-3, high CTR or conversions, or snippet and AI citations. Cohort 2: positions 4-10, stable. Cohort 3, growth: 11-25, or 4-10 with low CTR. Cohort 4: 25+ or crawled but not indexed.
2. Add CMS override fields: template_lock, custom_meta_title, custom_meta_description, custom_h1, custom_lead_summary, custom_schema_json. Manual values override formulas. Lock Cohort 1.
3. Fix architectural causes first, such as canonical errors or missing facet URLs.
4. Layer 1: title and description formulas plus data-nosnippet, on 50-100 URLs from Cohorts 3-4. Evaluate after 2-3 weeks.
5. Layer 2: extractable tables, lists and calculators, without deleting working text. Evaluate after 3-4 weeks.
6. Layer 3: H1-H4 restructure, Answer-first and fluff removal, on Cohorts 3-4 only. Evaluate after 4-6 weeks.
7. Layer 4: JSON-LD @graph sync. Check GSC after 2 weeks.
8. Layer 5: tag chips, cocoon links, alt and slot matrices.
9. Split test: divide homogeneous URLs 50/50 into test and control. Over 21-28 days compare clicks, impressions, indexing buckets, cannibalization and conversions.

### Decision rules

- Cohort 2: keep the H1 and body and add only missing nodes.
- Cohort 4: rebuild it, or 301 it into a stronger page.
- Protected pages get manual point edits only, and only for a proven defect.

### Thresholds

- Lookback: 90 days
- Sample: 50-100 URLs
- Layer windows: 2-3, 3-4, 4-6 and 2 weeks
- Split test: 21-28 days

### Checklist

- Override-fields architecture (6 fields)
- Five template principles: intent fit, passage-friendly, contentEffort slots, a unique data layer, anti-template

### Anti-patterns

- Changing everything on 100% of URLs at once
- Judging by domain-wide average position
- Identical leads with one-word substitutions
- Mass AI rewrites to fix indexing problems

### Human checkpoints

- Approve the protected list
- Populate overrides on flagship pages by hand

### Tools

- GSC
- GA4 or Metrica
- CMS
- google, yandex skills

### Feeds

- seo-project-life monitoring
- gsc-snippet-ctr-audit

**Output:** Templates rolled out by cohort, protected pages locked, split-test report

**Done when:** All layers clear their windows without GSC regressions and the test group beats the control over 21-28 days

## Minimum Viable Cluster batch release in waves (pp. 379-381)

**Trigger:** Publishing new landing pages or entering a new cluster

**Inputs:** Approved MVC packet, 3-5 indexed donor pages per new URL, Top-10 competitor pages

### Steps

1. Confirm that existing pages at positions 8-20 are already being upgraded (striking-distance first).
2. Assemble a closed packet of 6-9 documents: 1 Target, 2-3 Mixed, 3-5 Support, in alternating formats (overview, guide, comparison matrix, scenario selection, error breakdown).
3. Build each page in layers: answer-first first screen; entity/QBST frame; calculation or table block; experience layer; at least one artifact absent from the top-10.
4. Make every H2-H3 a standalone capsule with the direct answer in its first two sentences.
5. Wire the links from hour one: Mother and Daughter links, a bridge from an authoritative hub to the Target, and 3-5 in-body links from indexed donors.
6. Publish 1-2 clusters (10-20 URLs) per wave, keeping 3-5 vertical deepening pages per 1 horizontal page, and watch indexing in GSC.

### Decision rules

- If 'crawled, currently not indexed' rises, pause the next wave until quality is fixed (p.381).

### Thresholds

- 6-9 docs per MVC (p.380)
- 10-20 URLs per wave (p.381)
- 3-5 vertical per 1 horizontal (p.381)

### Checklist

- Pre-launch filter for any new URL p.379

### Anti-patterns

- Dripping single isolated articles across clusters
- Dumping hundreds of drafts at once

### Human checkpoints

- Verify the one-line differentiation before each copy task (p.381)

### Tools

- seo-page graph
- gist-content-logic
- GSC

### Feeds

- striking-distance-link-boost
- rank-monitoring
- topical-expansion-incubation

**Output:** Published, fully interlinked MVC with an updated sitemap

**Done when:** All pages are indexed and none are orphans, and the 'crawled, not indexed' share does not grow

## Wave-based architecture rollout with control pauses (pp. 297-298)

**Trigger:** Executing a reconstruction registry on an established site

**Inputs:** Approved decision registry and canonical cluster map

### Steps

1. Wave 1 (weeks 1-2): consolidate host/slash mirrors, block junk sort and empty filter parameters via robots and canonical, 410 broken utility URLs.
2. Wave 2 (weeks 3-4): noindex-follow non-target tags, date/author archives and empty categories; strip the sitemap to core architecture.
3. Wave 3 (weeks 5-7): merge cannibal articles and duplicate service pages onto the winners with direct 301s.
4. Wave 4 (weeks 8-9): rebuild the menu, BreadcrumbList and directional links (Support -> Mixed -> Target); eliminate orphans.
5. Wave 5 (week 10+): upgrade core hub content, tables and JSON-LD; publish Support pages that fill gaps.
6. Between waves, pause 2-3 weeks and verify: crawler link score, orphans and click depth; logs/GSC show recrawl of 301s and less crawling of blocked parameters; cohort visibility, with no SERP rotation between competing URLs.

### Decision rules

- Never deploy everything in one day; the book expects 3-4 months of turbulence if you do (p.297).

### Thresholds

- Pause 2-3 weeks between waves (p.297)
- Click depth 2-3 to Target/Mixed (p.298)

### Checklist

- Post-wave verification checklist pp.297-298

### Anti-patterns

- Mass deletions, redirects, URL changes, menu rebuild and rewrites on one day

### Human checkpoints

- Go/no-go on each wave after the control pause (pp.297-298)

### Tools

- seo-agent
- crawler
- GSC
- seo-project-life

### Feeds

- internal-link-graph-audit
- striking-distance-link-boost
- rank-monitoring

**Output:** Restructured live site graph and per-wave verification reports

**Done when:** No important page has 0 inlinks, depth is within 2-3, URL rotation has stopped, and every indexed URL has an intent, role and Mother link

## Bounded pilot rollout with baselines and live scenario QA (pp. 669-694)

**Trigger:** Deploying a new or restructured cocoon

**Inputs:** Approved page versions, Connected page slice covering one scenario, State snapshot and rollback plan, Test scenarios, Baseline metrics

### Steps

1. Choose a connected slice that covers one complete user scenario (category, cards, comparison, guide), not a convenient page count.
2. Before release, record baseline metrics, how they may be interpreted, planned edits, dates, and concurrent factors (price, assortment, demand, ads). For each task, state the expected action and how it is measured.
3. Save the current state, prepare rollback, and define blocking errors: wrong values, unavailable answers, broken actions.
4. Verify on staging, then repeat everything on production after publishing.
5. Run the end-to-end journey from the first question to the outcome, including selectors (test models) and form delivery to the responsible person.
6. Compare live pages with approved drafts: headings, tables and captions, units, sources, images, conditional blocks, fragment targets, anchors and URLs, breadcrumbs, and fact values against the registry.
7. Log verified items, remaining limits, items that couldn't be checked, and owners.
8. Monitor availability, task completion, inquiry quality, returns, support load and search metrics. Expand only after recurring template errors are fixed.

### Decision rules

- Blocking error → stop the expansion.
- Growth without a valid comparison has an unconfirmed cause.
- A rise in one engagement metric doesn't prove the choice suits users.
- Lower order volume from early disqualification is judged with inquiry quality and returns.
- Technical correctness is confirmed separately from commercial effect.

### Checklist

- Live QA list (see reference table)
- Baseline recorded
- Owners assigned

### Anti-patterns

- Checking only that the homepage renders
- Claiming gains from registries alone
- Presenting TGA heuristics as Google factors
- Claiming zero cannibalization without auditing the whole site

### Human checkpoints

- Production check of selectors and forms
- Interpretation of lead volume with lead quality and confounders
- Owner per discrepancy

### Tools

- browser
- crawler
- CMS
- GSC
- analytics
- TGA

### Feeds

- page-and-section-audit
- targeted-fact-update

**Output:** Live verified pilot slice and post-release report

**Done when:** Template errors are fixed, scenarios pass on production, all gaps have owners, and the baseline vs. post comparison is noted with confounders
