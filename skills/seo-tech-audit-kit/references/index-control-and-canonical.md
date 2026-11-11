# Index control, robots.txt and canonicalization

## Choosing the right index-control mechanism per URL (noindex, canonical, Disallow, 301, 404/410, nosnippet) (pp. 62-109)

**Trigger:** Any URL or URL class needs to be excluded, merged, removed or limited in snippets

**Inputs:** URL or pattern, Index status (indexed or not), Backlinks and 90-day clicks, Whether users need access, Successor or equivalent page if any

### Steps

1. Check whether the URL is already indexed and whether it has backlinks or clicks.
2. If users need it but search doesn't: noindex,follow with robots open (service screens, date archives, thin 1-2 post tags, single-admin author archives, pre-release or email landings, facet intersections that an old CMS can't canonicalize).
3. If it duplicates a stronger URL and has links or clicks: rel=canonical to the clean base.
4. If it is a technical URL that is not indexed and has no value, at scale: Disallow.
5. If it is a technical mirror (http, www, uppercase, slashes, legacy) or a discontinued product with a successor: 301 to the canonical or successor.
6. If it is permanently gone with no equivalent and no backlinks: 410 and remove internal links. If it has backlinks: 301 to the closest relevant page or parent.
7. For temporarily out-of-stock items: keep 200, set schema to OutOfStock, add a notify form and similar items.
8. To keep content out of AI Overviews without deindexing: nosnippet or max-snippet:0, accepting the CTR loss, or cap with max-snippet:N.
9. For non-HTML files or bulk rules, use the X-Robots-Tag or Link canonical HTTP header.
10. For a page wanting Discover or image traffic: max-image-preview:large.
11. For maintenance: 503 with Retry-After; for temporary moves or A/B tests: 302/307.

### Decision rules

- Never combine noindex with Disallow on an indexed page.
- Meta robots and meta googlebot merge, and the most restrictive rule wins.
- The GSC Removals tool hides a URL for only about 180 days; follow up with noindex or 410.
- Long-term noindex,follow pages lose crawling and behave like nofollow, so they must not serve as link hubs.
- Never mass-301 deleted items to the homepage; Google treats that as Soft 404.
- 404s with no internal links do not hurt domain quality; on a small site, typo 404s can stay 404.
- For news and classifieds, swapping 404 for 410 on expired items frees roughly 15-20% of crawl budget (that figure is stated only for this case).
- 308 equals 301 for Google.
- A ranking dip in the first weeks after a correct 301 is expected, because NavBoost click data is tied to the URL.

### Thresholds

- Removals tool about 180 days
- Example Retry-After 3600 s
- 404 recheck schedule: decays from 1 day to 3 months

### Checklist

- Indexed? Backlinks? User value? Successor? Duplicate of whom?

### Anti-patterns

- Applying noindex instead of canonical to parameter duplicates that carry links or clicks
- Using one uniform method for all parameter classes
- 503 without Retry-After or kept for days
- Client-side meta refresh or JS redirects

### Human checkpoints

- Confirm the successor/equivalent mapping and business need for user-accessible pages

### Tools

- Nginx/Apache config
- GSC
- backlink DB

### Feeds

- content-pruning
- url-parameter-registry
- defect-backlog-prioritization

**Output:** Per-URL or per-pattern directive decision table

**Done when:** Every candidate URL class has exactly one assigned mechanism

## Five-level diagnosis and fix for non-indexed pages (Crawled / Discovered / Soft 404) (pp. 85-92)

**Trigger:** A target URL is missing from Google or stuck in a non-indexed status

**Inputs:** Target URL(s), GSC URL Inspection and Pages exports, Crawler data, robots.txt

### Steps

1. Level 1, access and render: not blocked by robots, HTTP 200 (not 4xx/5xx/Soft 404), and the smartphone render shows critical content.
2. Level 2, directives: no noindex in head or X-Robots header; the canonical points to the intended URL.
3. Level 3, link connectivity: the page has internal inlinks (not an orphan) and shallow depth.
4. Level 4, document quality: main content is not an exact or near duplicate, and the unique effort matches the intent.
5. Level 5, domain health: the ratio of traffic pages to thin or junk pages on the host.
6. If Crawled not indexed: check for a sudden spike (possible hack or doorway injection), split technical junk from target pages, deindex or block junk in bulk, enrich target pages with unique data, tables and expert facts, and add links from trusted hubs.
7. If Discovered not indexed: remove traps and junk parameters, speed up TTFB, and strengthen internal links from authoritative pages.
8. If Soft 404: real 404/410 for dead URLs and remove homepage mass-redirects; out-of-stock items get the full page plus alternatives; for live pages, fix the JS/API render failure seen in URL Inspection.

### Decision rules

- Do not repeatedly press Request Indexing. Raise content effort, add internal links and reduce domain clutter instead.
- The first level that fails is the root cause; fix it before moving to the next level.

### Thresholds

- Target: 100% of commercially important pages indexed

### Checklist

- 5-level checklist (access, directives, links, quality, domain)

### Anti-patterns

- Request-Indexing spam
- 200 OK on empty 'not found' or CAPTCHA pages

### Human checkpoints

- Judge intent alignment and depth of coverage (content effort) manually

### Tools

- GSC URL Inspection
- Screaming Frog (Directives, Canonicals, Inlinks, Duplicates)
- site:

### Feeds

- content-enrichment-gist
- internal-linking-plan
- content-pruning
- canonical-alignment

**Output:** Per-URL blocking level with the specific remediation, plus enrichment/link tasks

**Done when:** Target pages move to Indexed in GSC

## Five-contour canonical synchronization and Google override resolution (pp. 90-132)

**Trigger:** GSC shows Google chose a different canonical, Duplicate without user canonical, or Submitted URL not selected; or sitewide canonical setup

**Inputs:** GSC canonical reports and Inspection, Desktop and mobile templates, sitemap.xml, Internal links, hreflang, redirect rules

### Steps

1. Inspect conflicting URLs to see which canonical Google selected.
2. Put a self-referencing canonical on every indexable page, in valid head before any div/img/iframe, and not replaced by JS. Use the Link header for PDFs and other non-HTML files.
3. Collapse canonical chains so every parameter URL points to the final URL in one hop.
4. Make the identical absolute URL (protocol, host, trailing slash) appear in all 5 contours: raw HTML canonical, sitemap, all internal links, hreflang, and 301 targets.
5. For a pure technical mirror, replace the canonical with a 301.
6. Run the 9-cause override checklist and fix what fails.
7. For syndicated copies, require a cross-domain canonical from the partner back to the original.

### Decision rules

- Google's canonical signals in descending strength: 301/308, rel=canonical, internal link graph, sitemap, HTTPS, NavBoost advantage, URL brevity.
- Duplicate without user canonical: add explicit canonicals on all variants.
- Submitted URL not selected: clean the sitemap of clones and align it with canonicals and links.
- Page with redirect is normal, but remove those URLs from the sitemap and menus.
- For hreflang pages, each language self-canonicals.

### Thresholds

- 1 hop maximum to the final canonical
- Boilerplate at 90%+ of HTML can make Google cluster distinct pages

### Checklist

- Canonical does not span pages with different centerpiece content (page-2 to page-1, out-of-stock item to category)
- Template chrome is not 90%+ of the HTML
- No chaotic GET combos that cluster regional pages
- Mobile canonical equals desktop
- No client JS rewriting the canonical
- WAF/CAPTCHA/error pages don't return identical 200 HTML
- No invalid elements in head before the canonical
- No canonical chains
- No hreflang-canonical conflict

### Anti-patterns

- Canonical from pagination or out-of-stock pages to page 1 or the category
- JS-injected or duplicated canonical
- Canonical chains through facet depth

### Human checkpoints

- Spot-check 'Alternate page with canonical' for categories accidentally canonicalized by a template bug

### Tools

- GSC URL Inspection
- Screaming Frog Canonicals tab

### Feeds

- sitemap-architecture-build
- hreflang-architecture
- fix-verification-regression

**Output:** Aligned canonical contours and a resolved override list

**Done when:** All 5 contours match and URL Inspection confirms Google picks the declared canonical

## Safe robots.txt authoring, sandbox testing, deployment and monitoring (pp. 68-84)

**Trigger:** Creating or changing robots.txt, or any staging-to-production release

**Inputs:** Draft robots.txt, Sample URLs (home, categories, filters, pagination, products, images, CSS/JS bundles), CMS type

### Steps

1. Place the file at the lowercase host root. It must be UTF-8 text/plain without BOM, under 500 KB, with an absolute Sitemap directive at the bottom.
2. Write rules: wildcard parameter patterns (/*?*param=), use $ anchors for extensions, use trailing slashes on folders, block service paths, print versions, thank-you/order-success and internal search, and keep all CSS/JS/fonts/API open.
3. Apply the CMS presets: WooCommerce/WordPress (block cart, checkout, account, add-to-cart params; allow admin-ajax; never block wp-includes, themes, plugins or uploads), Magento 2 (block checkout, customer, catalogsearch, var, app; allow pub/static and pub/media), Bitrix (block /bitrix/ but allow its cache, js and templates).
4. Load the draft into Screaming Frog's custom robots.txt tester and run it against the sample list.
5. Deploy, then check the live file within 5 minutes of every release to make sure a staging 'Disallow: /' did not ship.
6. After urgent changes, request a recrawl in GSC (Settings → robots.txt) to flush the 24-hour cache.
7. Check key templates in URL Inspection for zero blocked resources.
8. Set up file-hash monitoring that alerts Telegram or Slack on any byte change.

### Decision rules

- A specific User-agent group (Googlebot, Googlebot-Image) ignores the * group, so copy all base rules into it.
- Longest matching rule wins; on a tie, Allow beats Disallow.
- Paths are case-sensitive: force lowercase URLs with a 301.
- An empty 'Disallow:' allows everything, so never leave a stray one.
- A 404 on robots.txt means no restrictions. A 5xx halts crawling; after more than 30 days of 5xx Google uses the cached copy or lifts restrictions.
- Selectively Disallow heavy A/B-test, geo-redirect or personalization scripts that rewrite H1 or text; keep core JS open.
- Single-admin blog: Disallow /author/. Multi-author expert site: block only technical accounts.
- Untidy tags: Disallow if not yet indexed, otherwise noindex,follow first.
- AI crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended) can each get their own group; Google-Extended does not affect Search ranking.

### Thresholds

- Max 500 KB parsed
- Google cache 24 h
- Release check within 5 min
- 5xx fallback after 30 days

### Checklist

- Root location, lowercase name
- Sitemap directive present
- Assets open
- No staging Disallow: /
- Hash alert active

### Anti-patterns

- robots.txt in a subfolder or with an uppercase filename
- Parameter rules without a wildcard after the slash
- Prefix rules without a trailing slash or $
- Relying on default 2-line plugin files
- Using robots.txt to hide staging
- Disallowing indexed pages to remove them (they can still appear without a snippet)

### Human checkpoints

- Sandbox test review before deploy
- Review every checksum alert

### Tools

- Screaming Frog robots tester
- GSC robots.txt report and URL Inspection
- hash monitor + Telegram/Slack

### Feeds

- fix-verification-regression
- rendering-mobile-parity-check

**Output:** Deployed, verified, hash-monitored robots.txt

**Done when:** GSC fetch is clean, renders show no blocked resources, alerting is live

## Quick robots.txt check by site type (Appendix 2) (pp. 722-728)

**Trigger:** Technical audit, a new site launch, or post-update crawl checks

**Inputs:** robots.txt, Site type (WordPress, store, service)

### Steps

1. Confirm there is no blanket Disallow: /.
2. Block /wp-admin/ but allow admin-ajax.php. Keep /wp-includes/, theme and plugin folders open (WordPress, stores).
3. Block cart, checkout and account pages (stores, services). Block filter and sort parameters (stores).
4. Block internal search, UTM, print versions and deep pagination. Block tag archives that have no SEO value (WordPress).
5. Declare Sitemap:.

### Decision rules

- Use robots.txt to save crawl resources on technical nodes, noindex to remove URLs from the index, and canonical, sitemap and SSR to consolidate signals.

### Checklist

- 11 items per the Appendix 2 table

### Anti-patterns

- Blocking the CSS and JS needed for rendering
- Disallow: / left in place

### Human checkpoints

- Developer deploys the robots.txt change

### Tools

- skill:seo-agent

### Feeds

- seo-engineering-rollout

**Output:** robots.txt diff and a list of issues

**Done when:** Every applicable item passes
