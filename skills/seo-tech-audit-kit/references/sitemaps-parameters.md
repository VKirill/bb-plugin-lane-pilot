# Sitemaps, parameters, filters and duplicates

## Build and register a segmented sitemap index (pp. 63-102)

**Trigger:** New site or restructuring; site above 500-1,000 pages; nearing 50k URLs / 50 MB; segment diagnostics needed

**Inputs:** Canonical URL inventory, Real content-change timestamps, Taxonomy (templates, verticals, languages, update velocity)

### Steps

1. Filter to eligible URLs only: 200 OK, robots-allowed, no noindex, self-canonical.
2. Cover the four contours: home and root hubs, the commercial core (categories, demand-backed filter landings, products, services, pricing), informational pages, and E-E-A-T entity pages (About, Team/Authors, Editorial Policy, Contacts, Cases, Licenses, Legal).
3. Choose a segmentation model: by template (products in chunks of 10-20k), by vertical or year, by language (declare the xhtml namespace), or by velocity (a hot sitemap or News sitemap for items under 48 h vs evergreen).
4. Output only loc and honest lastmod in ISO 8601. Drop priority and changefreq. Gzip large files.
5. Aggregate into sitemap_index.xml with each child's latest lastmod.
6. Declare it in robots.txt and submit both the index and each child in GSC or the API.
7. For many languages, move hreflang into per-language sitemaps with xhtml:link for every version including self, plus x-default.

### Decision rules

- Update lastmod only on a real main-content change (rewrite or expansion, price or stock, attributes, new blocks or reviews), never on cron runs or template edits.
- Purge immediately if junk or conflicting URLs exceed 5-10%.
- Exclude the 10 blacklisted types: noindex, robots-blocked, redirects, 404/410, parameter or zero-demand facets canonicalized away, tracking parameters, utility/account/search URLs, pagination, Soft 404s, mass thin geo/tag pages.
- Treat the sitemap as a 100% clean diagnostic sample, not a speed-up tool.

### Thresholds

- 50,000 URLs / 50 MB per file
- Split above 500-1,000 pages (crawl section: at 10,000+)
- Products 10-20k per chunk
- Junk tolerance 5-10%
- Hot map items 48 h or newer

### Checklist

- Eligibility (200, allowed, no noindex, self-canonical)
- Four contours present
- Blacklist clean
- Index + children submitted

### Anti-patterns

- Monolithic sitemap on a large site
- Using the deprecated ping endpoint
- Submitting only the index file
- Building from raw, non-canonical DB fields
- Fake lastmod

### Human checkpoints

- Choose the segmentation model
- Define which changes count as significant updates

### Tools

- CMS generator
- GSC / Search Console API

### Feeds

- sitemap-health-monitoring
- hreflang-architecture

**Output:** sitemap_index.xml plus gzipped child sitemaps, registered in robots.txt and GSC

**Done when:** All children parse without errors, stay within limits and show per-segment coverage

## Sitemap governance: cohort indexation rate, lastmod credibility, post-release List-mode check (pp. 100-102)

**Trigger:** Weekly; visibility drop; within 24 h of a release or migration; monthly QA

**Inputs:** GSC Pages filtered to All submitted pages, Child sitemaps, 25 recently modified URLs, Screaming Frog List Mode, 30-day logs

### Steps

1. Weekly: switch GSC to All submitted pages. Check 404, Soft 404 and noindex, plus the three canonical/duplicate statuses. Compute indexed/submitted × 100 per child sitemap.
2. Compare cohorts. Send the failing template straight to a content and linking fix instead of running a full-site audit.
3. Lastmod credibility: take 25 URLs whose lastmod changed in the last 7 days, get the last crawl via Inspection or the API, and compare with the actual content change.
4. Post-release: regex-scan the raw XML for test drafts, broken Cyrillic encoding, http on an https site, missing slashes, raw DB IDs. Check new sections are in the right children and redirected URLs are removed.
5. Crawl every sitemap URL in List Mode. On any 3xx/4xx/5xx, noindex or canonical mismatch, roll back or patch.
6. Monthly: cross-check against verified Googlebot logs (see googlebot-log-analysis).

### Decision rules

- Indexation rate below 60-70% in a cohort: audit that template for low effort, boilerplate or weak links.
- Non-zero canonical/duplicate rows under submitted pages: rewire the generator to canonical fields.
- lastmod moved without content change while the last crawl was months ago: the date signal is compromised; emit lastmod only on significant updates.

### Thresholds

- Healthy rate 90-98%
- Critical below 60-70%
- Expected recrawl 24-72 h after a genuine update
- Post-release check within 24 h
- Canonical rows target 0

### Checklist

- Weekly GSC read status and ratios
- Monthly List crawl 100% clean
- Post-release XML router-bug scan

### Anti-patterns

- Waiting for rankings to recalculate instead of crawling the new sitemap in the first 24 h

### Human checkpoints

- Rollback decision after a failed post-release check

### Tools

- GSC
- GSC API
- Screaming Frog List Mode
- regex

### Feeds

- non-indexed-page-triage
- fix-verification-regression
- internal-linking-plan

**Output:** Per-segment indexation scorecard, lastmod trust verdict, release pass/rollback ticket

**Done when:** Every child sitemap is benchmarked, canonical rows are 0 and the List crawl is 100% 200 self-canonical

## URL policy and parameter registry for faceted navigation (pp. 110-154)

**Trigger:** Setting up or refactoring URLs or facets on a medium or large site

**Inputs:** Inventory of all CMS GET parameters, Current redirect, robots, canonical and sitemap config, Demand data

### Steps

1. First reduce the number of URLs the CMS can generate; then give each entity or selection exactly one canonical; then sync canonical, sitemap and links.
2. Classify URLs into four groups: indexable with demand, crawl-only navigation (pagination), crawl-blocked technical, empty combinations (404).
3. Normalize host and HTTPS in one 301; force lowercase; set one trailing-slash rule; never expose index files.
4. Have the backend emit parameters in a fixed order whatever the click order.
5. Build a registry with one row per parameter class (tracking, sorting, attribute filters, UI states). Each row gives SEO value, robots rule, index rule, canonical target, zero-result status and sitemap inclusion.
6. Render sort, view, per-page, warehouse and price-slider controls as button/span/select with AJAX plus replaceState or a hash.
7. Point non-indexable parameter URLs directly at the final canonical, and keep all of them out of the sitemap.

### Decision rules

- Run each URL through the 5-question funnel: standalone demand? does it change the selection or only order/view/tracking? stable non-zero items? can the template deliver clean URL, self-canonical, unique Title/H1, links and a sitemap entry? does it explode into tens of thousands of combinations?
- Tracking and sort parameters: canonical to base, robots Allow so the bot can read the canonical, no sitemap entry.
- Internal search: Disallow, noindex, no sitemap entry.
- Combinatorial no-demand parameters (price, size, warehouse): canonical or noindex is not enough; remove link generation and Disallow.
- Zero-product combos return 404, never a redirect or an empty 200.
- Obsolete promo or legacy parameters: 404/410.
- Already-crawled sort/view links eating budget: Disallow /*?*sort=, /*?*orderby=, /*?*view=.

### Thresholds

- 1 hop for normalization and canonical
- 0 items means 404
- 3+ combined attributes blocked by default

### Checklist

- URL hygiene baseline: one host, HTTPS, slash rule, lowercase, one pagination format, fixed parameter order, no tracking tails in internal links, only canonicals in the sitemap

### Anti-patterns

- Relying on canonical alone to manage facets
- Applying one method to every parameter class
- Chained canonicals through facet depth

### Human checkpoints

- Approve registry rows for borderline commercial parameters

### Tools

- Screaming Frog
- History.replaceState
- log analyzer

### Feeds

- seo-filter-whitelist
- robots-txt-lifecycle
- pagination-setup-audit
- defect-backlog-prioritization

**Output:** Parameter registry table plus implemented routing/robots/canonical/sitemap rules

**Done when:** Every parameter class has one rule, canonicals resolve in 1 hop, and internal links have no tracking or sort tails

## SEO filter whitelisting and clean-URL deployment (pp. 65-154)

**Trigger:** Capturing mid/long-tail commercial demand from catalog attributes without indexing combinatorial junk

**Inputs:** Keyword demand per attribute or combination, In-stock counts and stability, Templates, Googlebot logs

### Steps

1. Select candidates that meet all 5 criteria: verified demand, at least 5-10 in-stock items, stable assortment, a distinct offer vs the parent, and a template ready to support it.
2. Turn each one into a static clean URL (e.g. /laptops/lenovo/).
3. Keep it open in robots with a strict self-canonical.
4. Generate a unique Title, accurate H1, breadcrumbs and adapted content.
5. Link it with plain HTML from the parent category (popular-collection or tag bar) and add it to the category sitemap.
6. After launch, confirm in logs that the bot crawls the whitelisted URLs and not blocked combinations.

### Decision rules

- One-parameter strategic attributes (brand, type, purpose) with demand: whitelist.
- Two-attribute combinations: open only if backed by a verified semantic-core cluster.
- Three or more attributes, or utility filters (price range, exact size, warehouse, discount, search, compare): block and remove the links.
- Test: if this URL vanished tomorrow, would a distinct traffic cluster be lost? If not, keep it unindexed.
- Don't build a category, brand page, filter and tag page for the same query.

### Thresholds

- 5-10 in-stock items minimum
- 3 or more attributes blocked

### Checklist

- Whitelist qualification (8 items: demand, stock, stability, distinct offer, clean URL, open + self-canonical, unique meta and content, HTML links + sitemap)

### Anti-patterns

- Blocking all filters, or canonicalizing all of them to the parent
- A whitelisted page canonicalized to the parent or left as an orphan
- Self-canonical on unoptimized filter pages

### Human checkpoints

- Confirm demand and stock stability for each whitelisted combination

### Tools

- seo-tools (Mutagen/Wordstat)
- Screaming Frog
- log analyzer

### Feeds

- cocoon-architecture
- gist-page-brief
- sitemap-architecture-build
- hreflang-architecture

**Output:** Indexable filter landings linked from categories and present in sitemaps

**Done when:** Logs show regular crawling of whitelisted URLs and none wasted on blocked patterns

## Technical duplicate audit and semantic cannibalization resolution (pp. 112-113)

**Trigger:** Parameter bloat or canonical errors; several clean URLs rotating for the same query

**Inputs:** Screaming Frog crawl with the content area set (header/nav/sidebar/footer excluded) and Near Duplicates on, GSC query-page data

### Steps

1. Configure the content area so sitewide chrome is excluded. Crawl with non-canonicals included and Near Duplicates enabled.
2. Export parameter URLs, host and protocol mirrors, pages sharing a Title+H1, canonical chains and canonicals pointing to non-200 URLs.
3. Assign each technical group one template rule: 301, canonical, Disallow, or stop generating the URL.
4. For semantic duplicates, find them three ways: main-content near duplicates, overlapping Title/H1/entity markers and snippet promises, and GSC URL rotation for the same query.
5. Resolve each conflict with one method: merge into the strongest URL with 301s; separate intents by reworking headings, inventory and anchors; or set noindex,follow on auxiliary UX collections.
6. Separate informational selection guides from the commercial catalog.

### Decision rules

- Don't use canonical to merge pages with different layouts and text; Google often ignores it.

### Checklist

- One target URL per intent cluster
- No Title/H1 twins
- No canonical chains or non-200 canonical targets

### Anti-patterns

- Category, brand, filter and tag pages all targeting one query
- Using canonical against cannibalization

### Human checkpoints

- Choose the resolution per conflict: merge, separate intents, or demote

### Tools

- Screaming Frog
- GSC

### Feeds

- cocoon-architecture
- cocoon-audit
- defect-backlog-prioritization

**Output:** Duplicate groups with template rules and a restructured inventory with one page per intent

**Done when:** All duplicate groups have a fix and GSC URL rotation stops

## Thin and boilerplate page pruning (enrich / merge / noindex / 410) (pp. 68-150)

**Trigger:** Site has many low-effort pages: listings with 1-2 items, stubs, single-post tags, boilerplate city pages

**Inputs:** Crawl with main-content word count and product count, 6-12 months of organic data, Keyword demand per topic, Backlink data

### Steps

1. Export indexable URLs with fewer than 200-300 words of main content (or fewer than 3-5 products) and zero organic traffic over 6-12 months.
2. Check 90-day impressions and clicks and the backlinks before any delete or merge.
3. Classify each URL by demand and navigation value.
4. Real demand: enrich with products, expert detail, local cases and original data.
5. Narrow topic: merge into the parent or hub with a direct 301.
6. Navigation-only and no demand: noindex,follow. Obsolete: 410 at server level (e.g. a Nginx location rule returning 410, or an Apache rewrite with the Gone flag) after confirming no backlinks.
7. Remove internal links to anything deleted.

### Decision rules

- A high share of near-zero-effort pages drags down site-wide authority and pushes sections into cold storage.
- Pages with backlinks or traffic are never 410/404; they get 301 to the closest relevant page.

### Thresholds

- Under 200-300 words or 3-5 products, plus 0 clicks over 6-12 months
- 90-day check before deletion

### Checklist

- Each candidate has one action: enrich / 301 / noindex / 410

### Anti-patterns

- Mass auto-generated geo or tag pages in the sitemap
- Deleting pages that have backlinks

### Human checkpoints

- Approve the enrich vs merge vs delete classification (business value)

### Tools

- Screaming Frog
- GSC
- Nginx/Apache
- seo-tools (demand)

### Feeds

- content-enrichment-gist
- cocoon-architecture
- sitemap-architecture-build

**Output:** Pruned inventory with server rules and an enrichment task list

**Done when:** No indexable thin zero-traffic page is left unaddressed
