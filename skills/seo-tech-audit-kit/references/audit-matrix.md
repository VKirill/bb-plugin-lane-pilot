# Master Audit Matrix and defect prioritization

## Cross-source Master Audit Matrix with three-cohort sampling (pp. 147-154)

**Trigger:** Diagnosing signal conflicts sitewide; large domains with hundreds of thousands of URLs

**Inputs:** Crawler export (raw/rendered, status, hops, indexability, canonical, sitemap flag, depth, inlinks), GSC exports/API (index and canonical status, CWV, 90-day clicks), 30-day verified Googlebot logs

### Steps

1. On large sites, sample cohorts: A, priority business pages; B, risk zones (parameters, sorts, facets, pagination, search, tags, archives); C, GSC problem lists.
2. Join the sources by URL or template key in Python, BigQuery or a spreadsheet, using the mandatory fields.
3. Evaluate four conflicts: sitemap+200 but unindexed; indexed commercial pages with near-zero bot hits; heavy bot hits on URLs absent from crawl and sitemap; indexable in the crawler but non-canonical or excluded in GSC.
4. Compare bot hit share between cohorts A and B to quantify waste.

### Decision rules

- Sitemap+200 but unindexed: index selection (effort, clutter), duplicate checksum, or weak links.
- Indexed but rarely crawled: reduce depth, add inlinks, stop parameter leaks.
- Hits on unknown URLs: hidden traps, dynamic parameters, legacy sections, loops.
- Indexable but non-canonical: raw/rendered canonical divergence or a Google override.
- Bot share skewed to cohort B (e.g. 40% vs 15%, or 70-80% on facets): block the patterns and switch controls to AJAX now.
- Sitemap URL noindex or blocked: remove it from the sitemap or lift the block.
- Linked page with canonical elsewhere: fix to self-canonical or realign the links.

### Thresholds

- Depth flag >4 clicks
- Logs 30 days
- Clicks 90 days

### Checklist

- Mandatory fields (9): URL+template, status+hops, indexability/directives/JS diff, declared vs selected canonical, sitemap flag, depth+inlinks, 30-day hits+last crawl, CWV status, 90-day impressions/clicks

### Anti-patterns

- Auditing errors in isolation
- Joining a huge site whole instead of sampling

### Human checkpoints

- Define cohort A (business-priority pages) with the owner

### Tools

- Python / BigQuery
- Screaming Frog
- GSC API
- log analyzer

### Feeds

- defect-backlog-prioritization

**Output:** Master Audit Matrix with conflict flags and cohort crawl distribution

**Done when:** All three sources are joined and all four intersections are evaluated

## AI-assisted defect aggregation, 4-factor prioritization and team backlog routing (pp. 147-152)

**Trigger:** Turning thousands of row-level errors into an engineering backlog

**Inputs:** Master Audit Matrix export, Outputs of specialist audits (rendering, CWV, hreflang, parameters)

### Steps

1. Group row-level errors into template root causes by path regex and template type, recording affected URL counts and crawl-waste %.
2. Score each on Severity, Scale, Business Value and Dev Effort, then tier it P1-P4.
3. Route to queues: DevOps (301/410, 5xx, WAF allowlist, TTFB, caching); Backend (sitemap/lastmod, canonical generation, parameter order, 404 on empty facets and deep pages, hreflang Entity_ID); Frontend (SSR content and links, a-href pagination, CLS dimensions, INP, fetchpriority); SEO/Editorial (merges, effort enrichment, anchors, meta/schema).
4. Write each ticket with: defect, template and example URLs, root cause, implementation method, Definition of Done.

### Decision rules

- P1 Blocker: blocks crawl, render or indexation of commercial templates (5xx, accidental Disallow of pages or assets, forgotten noindex, mass Soft 404, broken catalog render).
- P2 High: systemic crawl waste, signal dilution or link-graph distortion (open traps, canonical conflicts, chains on linked URLs, orphan products).
- P3 Medium: degraded signals without index loss (CWV breaches, hreflang gaps, duplicate pagination titles, broken links to old posts).
- P4 Low: cosmetic (description overflow, decorative alt, unlinked old 404s).

### Checklist

- Ticket has all 5 sections
- Each task has an owner and before/after metric

### Anti-patterns

- Dumping raw URL exports on developers
- Prioritizing by crawler severity labels
- One unsegmented task list

### Human checkpoints

- Business-value scoring and effort estimates with the team lead

### Tools

- LLM (aggregation, scoring, spec-writing prompts in the text)

### Feeds

- fix-verification-regression

**Output:** Prioritized backlog of root-cause tickets per team

**Done when:** Every issue is aggregated, tiered, routed and has a DoD
