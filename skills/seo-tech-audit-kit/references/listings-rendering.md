# Pagination, infinite scroll and rendering parity

## SEO-safe pagination configuration and 7-point audit (pp. 66-154)

**Trigger:** Setting up or auditing category, blog, news or review pagination

**Inputs:** Pagination URL pattern, Templates (head, title, description, H1, SEO text, FAQ), Sort/filter rules, sitemap

### Steps

1. Pick one permanent URL format (/page/N/ or ?page=N, never #page=N); each page returns 200.
2. Give each page a self-canonical.
3. 301 /page/1/ or ?page=1 to the clean root, and make internal links to page 1 point to the root.
4. From page 2, append the page number to Title and description; keep the H1 natural.
5. Show the SEO text, description and FAQ on page 1 only.
6. Link pages with plain a-href. For long lists use stepped links: first 3 pages, ±3 around the current page, milestones 10/20/30, and the last page.
7. Isolate pagination from sort parameters (robots, non-anchor controls, or a canonical to the unsorted page).
8. Keep pages 2+ out of the sitemap.
9. Audit: canonical on pages 2, 3 and 5; a-href in raw HTML; out-of-range /page/999/ returns 404; page-1 handling; titles and duplicate text across the tail; reachability of items on page 10 and deeper; sitemap clean.
10. Give high-margin products and evergreen articles on deep pages extra entry points: subcategories, brands, SEO filters, related blocks, hubs, contextual links. Consider raising items per page to 36-48.

### Decision rules

- Never block pagination in robots and never canonicalize it to page 1.
- noindex,follow on pages 2+ is allowed only if every item is reachable through subcategories, tags or sitewide blocks.
- Keep rel prev/next if present (Bing uses it), but Google relies on a-href links.
- Pagination must never be the only link path to an important document.

### Thresholds

- Audit sample pages 2, 3, 5
- Deep check from page 10
- 36-48 items per page to flatten depth

### Checklist

- 7 control points
- Summary e-commerce/blog verification table

### Anti-patterns

- Hash pagination
- Repeating SEO text across pages
- Empty 200 on out-of-range pages
- Pagination URLs in the sitemap
- Linear-only pagination on large catalogs

### Human checkpoints

- Choose which deep items need extra entry points

### Tools

- Screaming Frog
- browser view-source

### Feeds

- internal-linking-plan
- infinite-scroll-implementation
- hreflang-architecture

**Output:** Self-canonical crawlable pagination plus an audit report with linking actions

**Done when:** All 7 control points pass

## SEO-friendly Infinite Scroll / Load More (progressive enhancement) (pp. 66-124)

**Trigger:** Building or fixing infinite scroll or a Load More button

**Inputs:** Server-side paginated endpoints, Loader script, Parameter rules

### Steps

1. Give every batch a deterministic permanent URL (?page=N). Avoid cursors, dates and random order.
2. Server-render each page URL directly with 200, a fixed non-overlapping batch and a self-canonical.
3. Put a real a-href to the next page inside the Load More control.
4. Update the address bar with IntersectionObserver plus pushState/replaceState when scrolling down and up.
5. Attach pagination only to clean canonical lists, after the parameter rules have been applied.
6. Protect INP with lazy images, DOM virtualization, or a cap of 3-5 auto-loaded screens before a classic next link.
7. Acceptance test: navigate the whole list with JS disabled; the URL changes while scrolling; ?page=3 opened in incognito returns 200 with a self-canonical; ?page=999 returns 404.

### Decision rules

- Without separate page URLs Googlebot sees only the first 12-20 items, because it doesn't scroll or click.
- A pushState URL that the server can't render directly is a defect: it breaks both bots and returning users.

### Thresholds

- Cap 3-5 auto screens
- INP degrades around 15-20 accumulated screens

### Checklist

- 4-step developer acceptance checklist

### Anti-patterns

- Appending JSON items to /catalog/ with no page URLs
- Button/div controls without a-href

### Human checkpoints

- Developer handoff acceptance test in DevTools

### Tools

- Chrome DevTools
- History API
- IntersectionObserver

### Feeds

- cwv-optimization
- fix-verification-regression

**Output:** Progressive-enhancement scroll backed by crawlable page URLs

**Done when:** All 4 acceptance checks pass

## JS rendering and Mobile-First parity inspection (GSC layered inspection + DevTools) (pp. 125-132)

**Trigger:** Checking what snapshot Google indexes; rendering failures; Mobile-First readiness; JS framework sites

**Inputs:** Target URLs per template, GSC property (or Rich Results Test for unverified/staging URLs), Chrome DevTools

### Steps

1. In URL Inspection, compare the indexed version with the live test, using the HTML tab (rendered DOM) rather than the screenshot.
2. Search the rendered HTML for the template checklist (category / product / article). Confirm one valid canonical, no stray noindex and the JSON-LD blocks.
3. Under More info, check Page resources for blocked JS/CSS/XHR and the JS console for errors.
4. In DevTools: Googlebot Smartphone UA, mobile viewport, disable cache, Fast/Slow 4G, 4x CPU slowdown. Clear site data, reload, and read the waterfall for failing APIs.
5. Compare view-source with the Elements panel to list second-wave JS dependencies, then disable JS and reload to see the first-pass baseline.
6. Check the 5 Mobile-First points: logs show smartphone-bot dominance with full 200 documents; Inspection confirms the smartphone indexer; block parity with desktop; schema and image parity; no intrusive interstitials.

### Decision rules

- Content injected only after click, scroll or touch, or requiring cookies, storage or geolocation, must move into the initial HTML.
- Collapsed tabs and accordions keep their full content in server HTML, hidden with CSS, not fetched on click.
- Use responsive design. Dynamic serving needs a 'Vary: User-Agent' header and synced templates. Avoid m-dot sites and dynamic rendering.
- Use SSR/SSG/ISR or a hybrid for public pages, not pure CSR.
- Links must be real a-href, not onClick spans or javascript:void.
- Lazy-load below the fold with native loading=lazy and a real src. Hero images load eagerly with fetchpriority=high.
- Critical JSON-LD goes in server HTML, not client JS or GTM.
- Never ship noindex in a SPA's raw HTML expecting JS to remove it; Google skips rendering.
- SPA routes that don't exist return a real 404 via SSR, or noindex if CSR can't set a status.
- Open API paths and Google datacenter IPs to the renderer.
- Mobile DOM must match desktop in main content, headings, links, schema and images; Google won't fill gaps from desktop.

### Thresholds

- Fast/Slow 4G, 4x CPU

### Checklist

- Rendered HTML verification (6 items)
- Category/filter/pagination checklist
- Product card checklist
- Article checklist (H1, all H2-H4, author link, dates, TOC, tables/FAQ, Article schema)
- 5 Mobile-First points

### Anti-patterns

- Assuming the phone view equals what the bot sees
- Slow APIs timing out before the render snapshot
- Trimming the mobile DOM to save space
- A second client-side canonical

### Human checkpoints

- Read the rendered HTML tab for core templates

### Tools

- GSC URL Inspection
- Rich Results Test
- Chrome DevTools
- chrome-devtools MCP

### Feeds

- bulk-dom-diff-ai
- defect-backlog-prioritization
- new-page-indexability-gate

**Output:** Per-template rendering and parity defect record

**Done when:** Required content, links, canonical and JSON-LD are confirmed in rendered HTML with no blocked resources or console errors

## Bulk raw-vs-rendered and mobile-vs-desktop DOM diffing with crawler + LLM (pp. 131-132)

**Trigger:** Large sites (tens of thousands of URLs) needing template-level rendering defect discovery

**Inputs:** 50-100 URLs per template (home, top categories, filters, pagination, in-stock and out-of-stock products, articles, help pages), Screaming Frog with JS rendering + Store HTML + Store Rendered HTML, LLM

### Steps

1. Compile the per-template URL samples.
2. Crawl with JS rendering and HTML storage under both desktop and mobile UAs. Export URL, Title, H1, canonical, meta robots, word count, unique inlinks and paired HTML.
3. Give the LLM five tasks: JS-only text, unrendered skeletons or missing commercial attributes, Mobile-First and E-E-A-T losses, client-side mutation of title/H1/canonical/robots, and lost a-href links. Instruct it to compare line by line, not give general advice.
4. Format the result as a developer table: template/URL, raw→rendered word count, H1/canonical match, raw→rendered link count, mobile-desktop parity, defect spec.
5. Spot-check every anomaly in GSC Inspection and DevTools before handoff.

### Decision rules

- The crawler and AI only sift URLs. Nothing goes to developers unverified.

### Thresholds

- 50-100 URLs per template

### Checklist

- Five diff tasks covered
- Every anomaly verified manually

### Anti-patterns

- Handing the raw AI output to developers

### Human checkpoints

- Manual verification of each template anomaly

### Tools

- Screaming Frog
- LLM
- GSC
- Chrome DevTools

### Feeds

- defect-backlog-prioritization

**Output:** Verified developer specification table of rendering and parity defects per template

**Done when:** All template samples are diffed in both dimensions and every anomaly is verified
