# seo-measurement-loop — Extended Playbook

## Procedures

### 1. Set up GSC cohorts (pp. 454–457)

1. Split brand from non-brand queries by regex (Cyrillic, Latin, typo variants).
2. Segment pages by functional directory: catalog, product, services, branches, guides, glossary.
3. Pages published in the last 90 days get their own cohort.
4. Split local queries into four buckets: service+city, service-no-geo, specialist+location, address/directions/phone.
5. Export all URLs getting impressions per commercial query to detect signal smearing.
6. Build the striking-distance queue: commercial queries at positions 8–20, high impressions, low CTR.
7. Define four metrics per page class: primary business metric, leading GSC signals, transit micro-conversions, defect metric.
8. Schedule weekly API exports to BigQuery/CSV joined with GA4 and CRM.

Thresholds: new-page cohort 90 days; striking distance 8–20; top-100 query labeling on impression spikes; brand lift horizon 1 month.

### 2. Triage anomalies into buckets A–D (pp. 459–461)

Ignore pages under 100 impressions. LLM-classifies each URL by real funnel role (discovery, mid-funnel, local terminal, commercial closing, brand-service) — never trust folder names. Then:

- **A**: position steady in top 5 (±1.0), impressions flat/up, CTR down >20% → inspect SERP for AI Overviews, carousels, broken rich results. Warning variant: impressions +35% with flat clicks, or CTR −25% at unchanged top-5.
- **B**: position down >4 with impressions and clicks falling together → ranking loss or cannibalization.
- **C**: clicks up >15% with flat/falling conversions → broken on-page commercial route.
- **D**: position 8.0–18.0, high impressions, good historical conversion → reinforce with internal links.

Also check: brand skew hiding non-brand decline; mobile-only ~30% drops; main page losing ~70% while an info article absorbs impressions. Tag every claim as *fact from data* or *cause hypothesis*. Details: `cohorts-and-anomalies.md` (a sibling file in the SKILL.md table).

### 3. Score the hypothesis 0–18 (pp. 47–49)

1. Write the card: what dropped, level (page/section/site), suspected defect, fix, confirming metric, evaluation window.
2. Attach affected URLs (10–20 for template hypotheses) and queries; explain why neighbors did not drop.
3. Compare against SERP winners, not team opinion. Low CTR is a symptom, not a cause.
4. Score 0–3 each on Pattern, Evidence, Alignment with Google's model, Scale, Business effect, Verifiability (max 18).
5. Run the 5-question pre-launch filter (need ≥3 confident yes) and record a falsification criterion.
6. Deploy alone inside its evaluation window.

Tiers: 0–5 weak → backlog; 6–10 working → after blockers; 11–14 strong → priority; 15–18 top → next sprint. Reject cards with no URL list, query list or neighbor explanation.

### 4. Write the 12-point task passport (pp. 462–464)

Tag purpose (growth/recovery/prophylaxis), then six fields: metric delta; scope (query/URL/template cohort/directory); start date cross-checked against releases and Google updates; exact cohort URL list; user drop-off step; working hypothesis naming the exact change. Reject tasks with no quantified anomaly, no isolated cohort, 10 bundled edits, or no verification criterion.

Score 1–3 on four criteria (max 12): Revenue (info=1, Mixed L2=2, Target L1/branch/margin SKU=3); Signal purity (blurred=1, section+noise=2, same-template cohort with clean control=3); Cost (backend/approvals=1, editor+expert=2, SEO+editor 1–2 days=3); Scale (one page=1, 10–30=2, scalable 20-page pilot=3). Route: 10–12 → sprint; 7–9 → reserve or decompose; <7 → freeze. Backlog TTL 30–45 days, then re-verify instead of carrying over.

### 5. Pick the fix by defect contour (pp. 463–468)

- **Single URL**: sibling took its queries? Restore first-screen blocks, title, forms.
- **Template defect** (dozens of URLs drop together): open 10 growing vs 10 declining side by side; compare H1–H2, first-screen price, branch/author binding, comparison table, CTA, incoming contextual links; fix the recurring gap in the CMS template.
- **Device split**: do not touch copy — fix mobile snippet truncation, banner CLS, mobile LCP, table overflow.
- **Geo split**: keep service text; strengthen NAP block, branch/specialist bindings, area map, local cases.
- **Fact decay**: keep skeleton; surgically update prices, limits, specs, rules; log the change.
- **Role/intent decay**: restructure H2s, add tables for new micro-intents, change format, or spin off Support pages.
- **Full overhaul only if all hold**: >50–60% of section URLs degraded + shared template/hierarchy defect + a 15–20 URL pilot gave no response in 1 month + top-10 SERP dominant format changed.

### 6. Run a test-vs-control experiment + Change Log (pp. 458–459)

1. Pick a homogeneous pilot (30–50 URLs on large catalogs, ~20–25 elsewhere) and an untouched control of the same template, depth and baseline.
2. Pre-release log: release date, template, test/control counts, elements added, hypothesis with target % deltas, pre/post windows (14 or 28 days aligned by weekday), control check date, cancel criteria.
3. Ship **one isolated change** — no stacked URL/title/UI/linking changes that day. Fewer than 10 unrelated changes per day per cohort (p. 464).
4. Start the clock only after recrawl/reindex is confirmed.
5. Read the cascade in order: impressions & query breadth → cluster position → snippet CTR → on-page micro-conversions → CRM leads/orders.
6. Roll out to the whole section only after a positive delta vs control over the pilot window (2 weeks or 1 month).

Full Change Log schema and interpretation rules: `experiment-and-cadence.md` (a sibling file in the SKILL.md table).

### 7. Route into the three-queue backlog (pp. 47, 49–51)

- Triage each idea: blocker, multiplier or local polish? System, section or URL? What concrete damage if delayed 2 weeks?
- **Queue A** blockers: index, canonical, robots, 5xx, duplicates, junk index, template errors, critical mobile UX. **Queue B** multipliers: templates, sections, links, trust, structure, content systems. **Queue C** local tweaks: title, FAQ, snippets, microcopy. Unverified ideas → Idea Archive.
- Queue C never preempts open A/B items. No damage from a 2-week delay → not top priority.
- WIP limit: 1–2 major hypotheses per section; close the previous evaluation before starting the next.
- Store in seo-project-life: `BOARD.md` per slug, A/B/C queues, Idea Archive, stop-list, scaling-blocker register.

### 8. Run the cadence (pp. 462, 464–470)

- **Weekly**: Monday signals (directory slices, index/first impressions of 7–14-day-old URLs, positions 8–20 low CTR, impressions-up-clicks-flat flags, 5–10 manual browser inspections, pick 3–5 tasks scoring 10–12). Tue quick wins; Wed one template/one cohort/one hypothesis; Thu content & E-E-A-T enrichment with SME approvals; Fri pre-publish QA, recrawl requests, Change Log entries, TTL review. Never mix analytics, editing and coding within one day.
- **Monthly**: non-brand trends by template/cluster; cohorts losing CTR in top 5; support articles eating commercial demand; link throughput guides→commercial; 30–60-day survival of new clusters; queue cleanup; 10–15 aging flagships audit.
- **Quarterly**: Target→Mixed→Support pyramid audit (orphans, dead ends, blurred jobs); topic drift; sitemap↔logs reconciliation and crawled-not-indexed cleanup; trust pages, sameAs, YMYL review dates, NAP vs GBP refresh; vertical checklist.

Bugs left "for later" pile up in behavioral data over ~2 months.

## Output contract

Returns to the calling node: cohort dashboard spec or anomaly action table (bucket A–D per URL with % and absolute deltas, fact/hypothesis tags, inspection target); scored hypothesis card (0–18 + tier + falsifier); task passport (six fields + 12-pt score + queue + TTL); scoped fix spec (contour named); Change Log record; cadence review decisions.

## Called by

- `seo-monitor` (weekly monitoring graph): cohort setup, anomaly triage, cadence.
- `seo-release`: Change Log records, experiment gating before rollout.
- `seo-drop-diagnosis`: hypothesis scoring and task passport for diagnosed drops.

## Limits

- A human picks the priority hypothesis and approves each sprint; the agent never self-approves score-18 cards.
- No causation claims from a single change without a control cohort.
- LLM bucket labels are hypotheses until a human inspects the page or SERP.
