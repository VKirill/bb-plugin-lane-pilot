# Crawl budget, logs and spider traps

## Technical readiness gate before content or link investment (pp. 60-64)

**Trigger:** Start of any SEO project, before building a cocoon or publishing new pages on an existing site

**Inputs:** Site domain, GSC property access, Crawler export, Server logs if available

### Steps

1. Check the document lifecycle for the site's key templates in order: discovery in the link graph, access permissions, crawl allocation, HTML download, rendering, index admission.
2. Run the 6-marker Crawl Health checklist: index cleanliness, sitemap validity, rendering access, redirect length, broken links, server response speed.
3. Count failed markers and pick the route: pass, partial pass, or tech-first.
4. If the route is tech-first, start crawl-budget-audit-remediation and the master technical audit before content work; otherwise allow cocoon production and record open risks.
5. Record the baseline metrics for later before/after comparison.

### Decision rules

- If 2 or more of the 6 markers fail, fix crawl leaks and rendering blocks before investing in content or link building.
- A site that looks and works fine in a browser is not proof that bots can crawl it. Check bot access and parameter traps separately.
- Crawl budget comes from Crawl Capacity Limit (server) and Crawl Demand (authority, URL popularity, update frequency). Manage both.

### Thresholds

- TTFB green zone below 200-300 ms
- Zero redirect chains of 2+ hops
- Sitemap URLs 100% 200 OK canonical
- 4xx/5xx internal links near 0%

### Checklist

- Zero sort/UTM/internal search/cart/staging URLs in the index
- 100% of sitemap URLs are 200, canonical, indexable and have honest lastmod
- All JS/CSS/fonts open, main content visible in the Googlebot render
- No 2+ hop chains or loops
- No internal links to 404/410/5xx
- Average response time and TTFB below 200-300 ms

### Anti-patterns

- Producing content and backlinks on a site whose key pages are blocked, buried under facet duplicates, falsely canonicalized or behind long redirect chains
- Judging technical health only from the human browser experience

### Human checkpoints

- Owner confirms GSC and log access, or accepts a reduced-confidence gate

### Tools

- GSC
- Screaming Frog / Sitebulb
- site: operator
- seo-agent skill

### Feeds

- crawl-budget-audit-remediation
- gsc-technical-baseline
- master-audit-matrix
- cocoon-architecture

**Output:** Gate verdict (pass / tech-first) with failed markers and a baseline snapshot

**Done when:** All 6 markers are evaluated with evidence and a route is recorded

## Primary technical diagnostics in Google Search Console (pp. 87-149)

**Trigger:** First step of any technical audit, before looking at Performance traffic charts

**Inputs:** GSC property, 10-20 sample URLs per template (home, category, SEO filter, pagination, product, article, language version)

### Steps

1. Indexing → Pages: record the unindexed buckets (Crawled/Discovered not indexed, Soft 404, canonical conflicts). Toggle between All known pages and All submitted pages to separate external noise from sitemap defects.
2. Run URL Inspection on 10-20 URLs per template. Compare the declared and Google-selected canonical, check the last crawl date and agent (Googlebot Smartphone), and check that the rendered HTML has text, headings, prices, schema and a-href links, with no blocked JS/CSS.
3. Sitemaps report: check the read status of the index and child sitemaps, the last processed date, and the submitted-to-indexed ratio per segment.
4. Crawl Stats: check daily request volume, bytes, response-time spikes, status-code mix, file-type share and discovery vs refresh split.
5. Core Web Vitals: list mobile and desktop URL groups failing LCP, INP or CLS on 28-day CrUX data.
6. Check Manual Actions and Security Issues.
7. Triage every Not-indexed status by alarm level and route it to the matching procedure.

### Decision rules

- High alarm: Crawled not indexed, Discovered not indexed, Soft 404, Google chose different canonical, 403. Medium: duplicate without user canonical, submitted URL not selected as canonical. Selective: 404, act only if it has external or internal links. Control: noindex, robots.txt, 401, removal tool. Normal: alternate page with canonical, page with redirect.
- A sharp rise in Discovered not indexed points to a crawl capacity or demand bottleneck from homogeneous URL bloat.
- A high volume of Crawled not indexed points to a duplicate or thin-content problem.
- Hundreds of 401/403 URLs mean public templates link to account, API or admin areas; remove those links.
- If raw logs are unavailable, still use Crawl Stats as a proxy.

### Thresholds

- 10-20 URLs per template for manual inspection
- Response-time spike flag above 300-400 ms
- CrUX window 28 days

### Checklist

- Declared canonical equals Google-selected canonical
- Recent crawl by Googlebot Smartphone
- Rendered HTML has main text, headings, prices, schema, links
- Zero blocked JS/CSS and zero script errors
- Crawl Stats dominated by 200 OK; no 5xx spikes

### Anti-patterns

- Starting the audit from Performance traffic charts
- Checking only the screenshot tab instead of the rendered HTML

### Human checkpoints

- Visually confirm rendered screenshots and the HTML tab for core templates
- Spot-check 'Alternate page with canonical' and 'Excluded by noindex/robots' samples after releases for accidental blocks of commercial pages

### Tools

- GSC
- GSC API (URL Inspection)
- google skill

### Feeds

- non-indexed-page-triage
- canonical-alignment
- sitemap-health-monitoring
- cwv-optimization
- master-audit-matrix

**Output:** GSC baseline report: index buckets per template, canonical mismatches, sitemap ratios, crawl-health anomalies, failing CWV groups, penalties

**Done when:** All six GSC report areas and the per-template samples are inspected and documented

## Crawl budget leak audit and 8-step optimization protocol (pp. 60-70)

**Trigger:** Initial audit; discovered URLs in GSC are 3-5x the clean sitemap and traffic pages; many unindexed URLs; after a migration or release

**Inputs:** GSC Page Indexing, Performance (90 days) and Crawl Stats, 30 days of verified Googlebot logs, sitemap.xml and robots.txt, Full crawl with JS rendering

### Steps

1. Record the counts for Crawled not indexed, Discovered not indexed, and Alternate page with proper canonical.
2. Run a full crawl with JS rendering on, so client-side links are captured.
3. Compare URL totals across the triangle of crawler, sitemap and Google index.
4. Filter every URL containing '?' in crawler and GSC exports to list leaked parameters, and compare them with verified log hits.
5. For junk parameter URLs that are not yet indexed: Disallow the pattern and swap their a-href links for buttons or spans. For junk that is already indexed: serve noindex, follow, keep it crawlable until it leaves the index, then Disallow.
6. Export internal links pointing to 3xx/4xx/5xx and replace them in templates or the DB with direct 200 canonical links (crawl monthly).
7. Clean the sitemap down to 200 indexable canonicals with honest lastmod; split it at 10,000+ URLs via sitemap_index (see sitemap-architecture-build).
8. Reduce TTFB with server caching (Redis/Varnish), DB query tuning and a CDN.
9. Flatten all redirect chains to a single 301 (see redirect-chain-cleanup).
10. Open all .js, .css, font and API resources in robots.txt and confirm rendering in URL Inspection.
11. Sort indexable URLs by word count and Title/H1 uniqueness and send thin ones to content-pruning.
12. Monitor Crawl Stats and the indexing queues daily for 10-14 days after structural changes.

### Decision rules

- Discovered-to-clean-URL ratio of 3-5x indicates severe bloat from parameters, duplicates or traps.
- If TTFB is above 600-800 ms, Googlebot reduces its crawl rate. Target below 200-300 ms.
- If new landing pages are still Discovered not indexed 10-14 days after release, investigate internal linking, sitemap validity and server limits.
- A single-parameter facet with verified demand becomes a static clean-URL landing; multi-parameter, no-demand, sort, limit and view facets get Disallowed and canonicalized to the parent, with parameter order normalized and AJAX controls.
- Do not block UTM parameters on normal-size sites. Block them only in a server-overload emergency.
- Service paths are Disallowed plus X-Robots noindex; staging/dev hosts are locked with 401 Basic Auth or an IP allowlist, not robots.txt.

### Thresholds

- Unoptimized sites waste 70-80% of crawl budget
- Cleanup reclaims 50-80% of crawl capacity
- Log window 14-30 days
- Commercial TTFB working standard below 300-400 ms
- Post-change monitoring 10-14 days

### Checklist

- Crawl Health 6 markers (see technical-readiness-gate)
- Four crawl-queue priority signals: PageRank/internal links, real update dynamics, server health, honest lastmod

### Anti-patterns

- Disallowing already-indexed junk before deindexing it, which leaves it stuck in the SERP because the bot can't read noindex
- Spending crawl on parametric junk, empty filter combos, sort duplicates and broken links
- Blocking assets folders (/js/, /css/, /wp-includes/, /bitrix/js/)

### Human checkpoints

- Approve which parameter patterns are commercial (whitelist) before blocking
- DevOps decision on caching/CDN changes

### Tools

- GSC
- Screaming Frog / Sitebulb / Netpeak Spider
- log analyzer
- site: + inurl: operators

### Feeds

- robots-txt-lifecycle
- sitemap-architecture-build
- redirect-chain-cleanup
- content-pruning
- url-parameter-registry
- defect-backlog-prioritization

**Output:** Prioritized remediation plan: robots.txt rules, link-template fixes, clean segmented sitemaps, single-hop redirects, TTFB actions

**Done when:** Discovered-vs-canonical discrepancy is eliminated and all 6 Crawl Health markers pass

## Verified Googlebot server-log analysis (patterns, phantom URLs, sitemap cross-matrix, API fetch chain) (pp. 71-131)

**Trigger:** Monthly audit, crawl budget waste suspected, important pages unindexed, missing commercial data in renders, or a sudden spike in unique crawled URLs

**Inputs:** 14-30 days of raw access logs (Nginx/Apache/CDN), Flat list of all sitemap URLs, Crawler URL list, Internal API endpoint paths

### Steps

1. Verify real Googlebot by reverse DNS (googlebot.com / google.com) or Google's official IP ranges file; drop UA-only matches.
2. Extract the Top-100 crawled URL patterns and the weekly unique-URL trend.
3. Find phantom URLs: present in logs but missing from both the crawler and the sitemap.
4. Join the sitemap URL list with 30-day verified hits (Python/BigQuery/VLOOKUP).
5. Sitemap Orphans (in sitemap, 0 hits) go to internal-linking reinforcement. Parasitic traffic (not in sitemap, many hits) goes to trap/parameter blocking.
6. Check that most requests come from Googlebot Smartphone and get full 200 documents.
7. On commercial templates, check that HTML fetches are followed by bot requests to price/spec APIs. Flag templates where they are not.

### Decision rules

- If weekly unique bot URLs jump out of proportion to new pages, audit the latest deploy, CMS update or plugin.
- If the bot fetches the HTML shell but never calls the data APIs, client JS is failing before the fetch; send it to rendering-mobile-parity-check.
- Above roughly 50,000 log lines a day, move from local Python or Screaming Frog Log Analyser to BigQuery, ClickHouse or ELK.

### Thresholds

- Log window 14-30 days (30 for cross-matrix)
- Local-analysis ceiling about 50,000 log lines/day

### Checklist

- Bot verified by rDNS/IP
- Top patterns listed
- Orphans and parasitic lists produced
- Smartphone share and API chain checked

### Anti-patterns

- Filtering logs by the Googlebot User-Agent string alone

### Human checkpoints

- Owner or DevOps must provide the log export; confirm the retention period

### Tools

- Screaming Frog Log File Analyser
- JetOctopus / Oncrawl
- Python Pandas
- BigQuery / ClickHouse / ELK

### Feeds

- spider-trap-remediation
- internal-linking-plan
- master-audit-matrix
- rendering-mobile-parity-check

**Output:** Two remediation lists (Sitemap Orphans, Parasitic URLs), top crawl patterns, bot UA distribution, broken API-fetch templates

**Done when:** Both discrepancy cohorts are extracted and routed; the API chain is verified on commercial templates

## One-day spider trap detection and fix (incl. dynamic image resizer traps) (pp. 70-74)

**Trigger:** Crawl far exceeds the real catalog size (e.g. 100k+ URLs for 5k products), a log spike in unique URLs, or stalled GSC queues

**Inputs:** GSC Page Indexing segmented by sitemap, Unrestricted crawl with JS rendering, 14-30 days of logs, URL Inspection and Chrome DevTools

### Steps

1. Screen the Discovered and Crawled-not-indexed queues per sitemap file. Run site: plus inurl: queries for sort=, filter=, session, utm_, search, page, ?p=, tag.
2. Crawl with JS rendering. Flag depth over 5 clicks (especially 10+ chains), repeating path segments from relative links, infinite calendars, session IDs, and a parameter-URL share above 15-20%.
3. In verified logs, list the top patterns and the phantom URLs.
4. Inspect 3-5 anomalous URLs in URL Inspection (rendered a-href). Emulate Googlebot Smartphone in DevTools with JS on and off while clicking 3+ facets, to find the component that generates the recursive links.
5. For images: filter bot requests to image files with ?w=, ?width=, ?size=, ?quality=, ?crop=. Replace them with static srcset presets, put the canonical hi-res URL in src and Product schema, and Disallow the resizer endpoint while keeping base images open.
6. Fix link generation in the templates or router. Apply robots.txt, canonical or noindex as appropriate.
7. Re-crawl to confirm the URL pool has shrunk, then check logs and Crawl Stats after 2-3 weeks.

### Decision rules

- Depth of 10+ clicks or more than 15-20% parameter URLs means an active trap; stop and fix it first.
- Normal working pages sit at 3-4 clicks or fewer; investigate anything deeper than 5.

### Thresholds

- Trap share above 15-20% parameter URLs
- Depth: investigate >5, trap ≥10
- Verification 2-3 weeks

### Checklist

- Relative links have a leading slash
- No infinite calendars or session IDs in links
- Facet links do not recurse

### Anti-patterns

- Relative internal links without a leading slash
- On-the-fly image parameter URLs exposed to bots

### Human checkpoints

- Manual DevTools facet-click emulation with JS on/off

### Tools

- Screaming Frog
- Chrome DevTools
- GSC URL Inspection
- log analyzer

### Feeds

- robots-txt-lifecycle
- url-parameter-registry
- fix-verification-regression

**Output:** Patched templates/router, updated robots.txt, before/after crawl and log evidence

**Done when:** Crawl shrinks to the true catalog size and logs show fewer wasted hits over 2-3 weeks
