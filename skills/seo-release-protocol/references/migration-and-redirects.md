# Migrations and redirects

## Three-stage site migration (inventory → redirect test → post-migration monitoring) (pp. 103-108)

**Trigger:** Moving to a new domain, CMS or URL structure

**Inputs:** GSC (16 months), GA4 (1-2 years), Full crawl, Current sitemap, Ahrefs/Majestic/Semrush backlinks, Wayback CDX API, Staging and production environments

### Steps

1. Stage 1: export GSC pages with impressions or clicks over 16 months plus top externally linked pages; GA4 organic and referral URLs over 1-2 years; a full crawl; sitemap canonicals; backlinked URLs including current 404s; and Wayback CDX historical URLs (collapse=urlkey, fl=original).
2. Merge the lists, dedupe, strip tracking parameters, and map each old URL 1:1 to its semantic equivalent.
3. Stage 2: in Screaming Frog List Mode with Always Follow Redirects, crawl the old list on staging and again right after cutover. Export All Redirects and check the defect table.
4. Stage 3: if the domain changes, submit Change of Address right after verifying the 301s. Watch the old property for growing 'Page with redirect' with no 4xx/5xx, and the new property for sitemap URLs indexing.
5. Weekly: export 'Page with redirect' URLs and re-run them through List Mode.

### Decision rules

- URLs with no 1:1 equivalent go to the nearest parent category, never to the homepage.
- Backlinked dead URLs always get a 301, never a 404/410.
- Expect a ranking dip and 2-3 months of stabilization; that is not an error.

### Thresholds

- GSC lookback 16 months
- GA4 1-2 years
- Every chain 1 hop via 301/308 to a 200 canonical
- Weekly re-test
- 100% terminate in 200

### Checklist

- Defect table: more than 1 hop; final 404/5xx; 302/307; target noindex or blocked; target canonical elsewhere; mass homepage redirect; loop

### Anti-patterns

- Building the map only from the CMS export or sitemap
- Postponing Change of Address
- 302 for permanent moves

### Human checkpoints

- Verify the 1:1 semantic intent mapping
- Two-stage audit sign-off (staging and production)

### Tools

- Screaming Frog
- Sitebulb
- GSC
- GA4
- Ahrefs/Majestic/Semrush
- Wayback CDX + curl

### Feeds

- sitemap-health-monitoring
- fix-verification-regression

**Output:** Validated old→new redirect map, Change of Address submitted, weekly verification logs

**Done when:** Every source URL resolves in 1 hop to an indexable 200 target and the new sitemap indexes cleanly

## Redirect chain audit and single-hop flattening across CDN, server and CMS (pp. 63-106)

**Trigger:** Technical audit; quarterly maintenance; suspected multi-hop chains

**Inputs:** Site crawl, Access to CDN, Nginx and CMS redirect rules, Templates and content for link updates

### Steps

1. Export Response Codes 3xx and the Redirect Chains report.
2. Filter chains of 2+ hops, prioritizing URLs with backlinks or internal links.
3. Check where each hop comes from at three layers: CDN (Cloudflare), Nginx and the CMS router.
4. Collapse sequential normalization (http→https→www→slash) into one hop, and remove stacked legacy migration rules so each old URL points straight to the final URL.
5. Replace client-side meta refresh and JS redirects with server 301s.
6. Replace internal links with direct 200 canonical URLs.

### Decision rules

- Googlebot follows up to 5 hops per session and 10 across sessions; each hop adds DNS/TLS/RTT latency and delays consolidation.
- Use 302 for permanent moves only briefly; a long-lived 302 makes the canonical choice unpredictable.

### Thresholds

- Target: zero chains of 2+ hops
- Run quarterly

### Checklist

- Zero 2+ hop chains
- No loops
- Internal links point at 200 URLs

### Anti-patterns

- Conflicting CDN/Nginx/CMS rules
- Internal links to redirecting URLs

### Human checkpoints

- DevOps sign-off on the merged rule set

### Tools

- Screaming Frog
- Cloudflare
- Nginx/Apache

### Feeds

- fix-verification-regression

**Output:** Single-hop redirect map and updated internal links

**Done when:** Redirect Chains report is empty and internal links resolve directly to 200

## URL preservation and redirect migration (pp. 669-693)

**Trigger:** Restructuring with URL retention or migration decisions

**Inputs:** Working URL inventory, Target URL and purpose mapping, Internal link graph and important external links

### Steps

1. Keep working URLs unless there is a concrete reason; a new position in the graph is not one.
2. Map each changed URL to a semantically matching destination and verify the target's intent.
3. Set permanent redirects and keep them as long as possible (Google advises usually at least a year).
4. Point internal links and reachable important external links straight to the final URLs.
5. On production, check final HTTP codes, absence of chains, canonicals, the XML sitemap and internal links. Log exceptions.
6. Mark the migration done only after live checks, not when the ticket closes.

### Decision rules

- Never mass-redirect deleted pages to the homepage.

### Thresholds

- Redirects retained ≥1 year (a recommendation, not a hard rule)

### Checklist

- Mapping
- 301s
- Internal links
- External links
- Codes
- Chains
- Canonicals
- Sitemap
- Exceptions

### Anti-patterns

- URL changes for diagram symmetry

### Human checkpoints

- Justify each URL change

### Tools

- crawler
- seo-agent
- GSC

### Feeds

- pilot-rollout-and-live-verification
- technical-indexing-audit

**Output:** Redirect map and verified migration log

**Done when:** Every migrated URL resolves directly to a matching destination, verified live
