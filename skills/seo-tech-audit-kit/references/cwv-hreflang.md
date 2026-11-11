# Core Web Vitals and hreflang

## Template-level Core Web Vitals diagnosis, fix and validation (LCP, CLS, INP, RUM) (pp. 133-139)

**Trigger:** GSC CWV report shows Poor or Needs Improvement groups; post-release performance check

**Inputs:** GSC CWV mobile report, 3-5 representative URLs per failing group, Templates, GTM container, web-vitals RUM in GA4

### Steps

1. Sort failing mobile groups by page count and traffic value.
2. Run 3-5 URLs per group through PSI and DevTools Performance with mobile throttling.
3. Break the template down: TTFB and HTML cache, blocking CSS/JS in head, the LCP element, lazy dynamic blocks, fonts, third-party scripts.
4. LCP fixes: remove lazy loading from the hero; add fetchpriority=high and dimensions; preload CSS-background or font-dependent LCP; WebP/AVIF with srcset (40-60 KB on mobile); HTML caching down to 100-200 ms TTFB; bfcache eligibility (no 'no-store', no unload handlers); Speculation Rules prefetch.
5. CLS fixes: width/height or aspect-ratio on all media, iframes and ad slots; min-height or skeleton for async blocks; fallback font metric overrides with swap, or optional for secondary fonts; fixed-position or pre-reserved top bars.
6. INP fixes: defer chats, callbacks, session recorders and pixels in GTM until interaction or idle (3-5 s); split handlers (feedback first, yield, then the heavy work); debounce inputs 200-300 ms; scope re-renders.
7. Verify in DevTools/Lighthouse, install web-vitals RUM and check next-day field data, then start validation in the GSC CWV report and wait out the 28-day CrUX cycle.

### Decision rules

- A page passes when 75% of real visits meet Good.
- TTFB at 1.5 s or more: fix server and caching first.
- The same failure across many similar URLs means a template fix; an isolated failure means page content (8 MB photo, embeds, calculator, custom animation).
- Green in Lighthouse but red in GSC: test low-end throttling, below-the-fold scrolling and filter clicks.
- Lighthouse can't measure INP (only TBT); use field data.
- If INP is poor and the cause is unclear, check third-party GTM scripts first; the book attributes about 70% of cases to them.
- GSC errors after a correct fix are normal 28-day inertia.

### Thresholds

- LCP ≤2.5 s good, >4 s poor
- INP ≤200 ms good, >500 ms poor
- CLS ≤0.1 good, >0.25 poor
- 75th percentile
- CrUX 28 days
- Long Task >50 ms
- Late banners at 500-800 ms cause CLS
- 60-80% of the gain is possible without a stack change

### Checklist

- Template decomposition (6)
- LCP breakdown: TTFB, load delay, load duration, render delay
- INP phases: input delay, processing, presentation

### Anti-patterns

- Chasing a Lighthouse 100
- Fixing URLs one by one
- Rewriting the frontend first
- Lazy-loading the hero
- Synchronous third-party widgets

### Human checkpoints

- Prioritize groups by business value
- Confirm the culprit DOM node or Long Task visually
- Press Start validation in GSC

### Tools

- GSC
- CrUX
- PSI
- Lighthouse
- Chrome DevTools
- GTM
- web-vitals
- GA4
- Speculation Rules API

### Feeds

- defect-backlog-prioritization
- fix-verification-regression

**Output:** Fixed templates, RUM telemetry and an active GSC validation

**Done when:** Lab confirms the fix, RUM improves the next day and GSC passes the group after 28 days

## Multilingual architecture and database-driven hreflang generation (pp. 99-145)

**Trigger:** Launching a multilingual or multi-regional site or adding a locale

**Inputs:** Target markets, Translated content and UI, DB entities with Entity_ID, Locale status (index/noindex)

### Steps

1. Fix a stable URL structure first (ccTLD, subdomain or language folders) and finish UI localization (titles, buttons, filters, breadcrumbs).
2. Set a self-canonical on every language version.
3. Bind all locales of an item to one Entity_ID and track the canonical URL and publish status per locale.
4. Generate each cluster from published, indexable locales only. Add a locale when it switches from draft to index.
5. Each page lists every alternative including itself, using ISO 639-1 plus optional ISO 3166-1 region, plus x-default for a selector or global version.
6. Choose the delivery method: head link tags for 2-5 languages, sitemap xhtml:link for dozens of languages (disable the HTML method), or the HTTP Link header for PDFs.
7. Keep all language URLs reachable from any IP with no auto-redirects; offer a manual switcher banner.

### Decision rules

- Same language across countries with different currency, shipping or legal terms: separate pages with language-region codes.
- Identical English country folders with no localization: consolidate, no hreflang.
- Single language and single market: no hreflang.
- No exact 1:1 equivalent: omit it; never point to another language's home page.
- Locales still in proofreading (noindex or blocked) stay out of clusters.
- Exclude pagination 2+ and dynamic facets; include only whitelisted static filters that have a real translation and local demand.
- When slugs differ or publish dates differ, generate from the Entity_ID map, never by swapping the prefix.

### Thresholds

- HTML method for 2-5 languages
- 100% of cluster URLs return 200 directly

### Checklist

- Language cluster checklist (8: direct 200s, self-canonical, self-hreflang, reciprocity, valid ISO codes, no parameters, not blocked, valid x-default)

### Anti-patterns

- Wrong codes (en-UK, jp, cz, by, kz, cn/tw, region-only)
- Canonical pointing to the main language
- HTML and sitemap methods drifting apart
- IP or Accept-Language redirects
- Invalid elements in head above hreflang

### Human checkpoints

- Decide which markets warrant separate regional pages

### Tools

- CMS/backend
- sitemap generator

### Feeds

- hreflang-audit
- sitemap-architecture-build

**Output:** Canonicalized multilingual URL set with generated reciprocal clusters

**Done when:** Live locales have stable URLs, self-canonicals, full UI translation and reciprocal links, with drafts excluded

## Hreflang cluster audit in Screaming Frog (pp. 141-146)

**Trigger:** After deploying hreflang or in a periodic multilingual audit

**Inputs:** Site or 50-100 URLs per template, Language sitemaps if used

### Steps

1. Enable crawl and store of hreflang, plus linked XML sitemaps if relevant.
2. Crawl until all linked locales are collected.
3. Run Crawl Analysis with hreflang checked.
4. Review the six filters: missing return links, missing self reference, incorrect codes, non-200 targets, not using canonical, noindex return links.
5. Reverse-sample one English URL per template: open every alternative and confirm identical head link sets.

### Decision rules

- Validate whole clusters, never single pages; Google ignores broken links and chooses the version itself.

### Thresholds

- 50-100 URLs per template
- 100% link-set agreement

### Checklist

- Six Screaming Frog filters clear

### Anti-patterns

- Auditing one page in isolation
- Assuming a language switcher means translations exist

### Human checkpoints

- Manual reverse-sample check

### Tools

- Screaming Frog

### Feeds

- defect-backlog-prioritization

**Output:** Categorized hreflang defect list

**Done when:** All six filters are clear and the reverse samples match 100%
