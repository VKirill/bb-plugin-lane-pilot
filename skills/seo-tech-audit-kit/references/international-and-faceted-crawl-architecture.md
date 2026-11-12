# International SEO, Bot Verification, HTTP Caching & Enterprise Faceted Crawl Architecture

Synthesized from:
- Eric Enge, Stephan Spencer & Jessie Stricchiola — *The Art of SEO* (4th ed., 2023)
- DrMax — *Доказательное SEO 2026* (Book 1 Ch.3–5, verified log forensics & crawl control)

---

## 1. International URL Topology Trade-Off Matrix (*The Art of SEO* 4th ed.)

Lock URL topology **before** launching a second language or regional storefront. Never use URL query parameters (`?lang=de`, `?loc=uk`) for indexable locales — Google explicitly discourages parameter-based localization because crawlers and users cannot segment regional authority cleanly.

| Topology | Example | Geo Signal Strength | Domain Authority & Link Equity | Ops / CDN / GSC Overhead | Best-Fit Scenario |
|---|---|---|---|---|---|
| **Subfolders (`gTLD + /locale/`)** | `example.com/de/`, `example.com/fr/` | Moderate (set via `hreflang` + local signals) | **Consolidated** — new locales inherit root domain authority immediately | **Lowest** — single TLS cert, one deployment, per-folder GSC properties | **Default for SaaS, content, marketplaces & global brands** |
| **ccTLDs (Country-Code Domains)** | `example.de`, `example.fr`, `example.co.uk` | **Strongest** native country signal & local user trust | **Split** — every ccTLD starts from zero backlink equity | **Highest** — separate domains, registries, legal entities, link budgets | Mature enterprise brands with dedicated country teams and PR |
| **Subdomains** | `de.example.com`, `fr.example.com` | Moderate (`hreflang` + GSC targeting) | **Partially split** — weaker inheritance than subfolders | Medium — separate DNS/hosting stacks, per-subdomain GSC properties | Only when regional infrastructure or legal isolation prevents shared routing |

---

## 2. The `hreflang` + Self-Canonical + Zero-GeoIP-Redirect Invariant

Over 60% of multi-locale SEO failures stem from conflicting canonicals and IP redirects breaking cluster reciprocity. Enforce three non-negotiable invariants on every multi-locale deployment:

1. **Per-Locale Self-Referential Canonical (`HARD INVARIANT`):**
   - Every indexable locale URL `U_loc` (e.g. `https://example.com/de/pricing`) **must** emit `<link rel="canonical" href="https://example.com/de/pricing" />`.
   - **Fatal anti-pattern:** pointing `/de/pricing`'s canonical to `/en/pricing` while listing `/de/pricing` in `hreflang`. That tells crawlers `/de/pricing` is a duplicate to deindex and breaks the entire `hreflang` return-link graph.
2. **Complete Bidirectional `hreflang` + `x-default` Equivalence Class:**
   - Every published, `200 OK` indexable member of an entity cluster emits the **exact same set** of `<link rel="alternate" hreflang="..." href="..." />` entries — including a **self-link** for its own locale plus `hreflang="x-default"` pointing to the global/default language version or country-selector hub.
   - Use strict `ISO 639-1` language codes (`de`, `es`, `ja`) optionally paired with `ISO 3166-1 Alpha-2` region codes (`en-GB`, `de-AT`, `es-MX`, `pt-BR` — never `en-UK` or region-only `UK`).
   - Pick **one** canonical emission layer (`<head>` tags for ≤5 locales, XML sitemap `xhtml:link` for >5 locales, or HTTP `Link` header for PDFs) so HTML and XML never drift. Exclude `noindex`, `3xx`, `404`, draft locales, and parameterized URLs from clusters.
3. **Strict Ban on GeoIP & `Accept-Language` Auto-Redirects:**
   - Googlebot Smartphone, Bingbot, and AI/RAG crawlers fetch predominantly from US datacenter IPs without `Accept-Language` headers or locale cookies.
   - Any `301`/`302` server redirect from `/de/` or `/` based on GeoIP or `Accept-Language` traps crawlers inside a single locale and starves all other languages from discovery and re-crawl.
   - **Engineering rule:** Serve `200 OK` on every locale URL from every IP worldwide; render a lightweight, non-blocking client banner («Viewing English — Switch to Deutsch») when browser language differs.

---

## 3. Verified Bot Identity, Conditional HTTP Caching (`304`) & `Vary` Headers

### Two-Step DNS Bot Verification (*Доказательное SEO 2026*)
Never analyze crawl waste or gate dynamic rendering using raw `User-Agent: ...Googlebot...` substrings (trivial scraper spoofing):
1. **Reverse DNS (`PTR`) lookup** on the client IP → verify hostname ends with `.googlebot.com`, `.google.com`, or `.googleusercontent.com` (or `.search.msn.com` for Bingbot; `.yandex.ru`/`.yandex.net`/`.yandex.com` for YandexBot).
2. **Forward DNS (`A`/`AAAA`) lookup** on that exact hostname → verify it resolves back to the **identical source IP**; cross-check against official published CIDR JSON ranges (`googlebot.json`, `special-crawlers.json`) for high-throughput batch pipelines.

### HTTP Conditional Requests (`ETag` / `If-Modified-Since` → `304 Not Modified`)
Crawl capacity depends on server latency and bandwidth per fetched URL:
- Emit deterministic strong **`ETag`** (content hash) and accurate **`Last-Modified`** HTTP headers on HTML pages, sitemaps, and feeds whose body has not changed.
- Honor incoming crawler **`If-None-Match`** and **`If-Modified-Since`** headers by returning **`304 Not Modified`** with an empty body in `< 50 ms` TTFB.
- Never touch `Last-Modified` or sitemap `<lastmod>` on deploy timestamps when visible main content and structured data are unchanged; crying wolf trains crawlers to ignore date hints.

### `Vary` Header Hygiene
- **`Vary: User-Agent`**: emit **only** when the origin genuinely serves distinct mobile vs desktop HTML payloads (dynamic serving). On responsive single-HTML sites, omit `Vary: User-Agent` so CDN edge caches remain unified.
- **Avoid `Vary: Accept-Language` and `Vary: Cookie` on public indexable URLs**: varying HTML content at the same URL by language header violates per-locale URL addressability and shatters CDN hit ratios.

---

## 4. Enterprise Faceted Navigation Crawl-Budget Matrix

An e-commerce or directory catalog with $M$ categories and $F$ multi-select facets quickly generates $M \times \prod (k_i + 1)$ combinations — turning 5,000 real products into millions of low-value URLs that exhaust crawl capacity and dilute link equity. Enforce this 4-tier routing matrix at the router/template layer:

| Facet Tier | Qualification Criteria | URL & Link Generation | `robots.txt` / Meta Directive | Canonical & Sitemap Policy |
|---|---|---|---|---|
| **Tier A — Indexable Demand Facets** | 1-attribute (brand, core type) or 2-attribute intersection with **verified search demand**, **≥5–10 stable items**, and distinct commercial intent | Static clean path (`/laptops/lenovo/`), crawlable `<a href>` from parent hub, unique H1/Title/intro | `robots.txt`: Allow; Meta: `index,follow` | **Self-canonical**; included in segmented XML sitemap |
| **Tier B — Single Sort / Tracking / View Tails** | `?sort=price_asc`, `?view=grid`, `utm_*` (external or legacy links exist; zero standalone search demand) | **Zero `<a href>` in DOM** — render UI controls as `<button>` / `<select>` with AJAX + `History.replaceState`; enforce fixed parameter key order | `robots.txt`: Allow initially if canonical consolidation is needed; `Disallow: /*?*sort=` once crawl waste appears in logs | Canonical → clean base category (`1` hop); **excluded** from XML sitemap |
| **Tier C — Combinatoric Parameter Explosion** | **≥3 combined attributes**, multi-select checkboxes (`?brand=a,b`), price/dimension sliders, warehouse/stock toggles, internal site search (`/search?q=`) | **Suppress `<a href>` emission completely** in SSR HTML (client state or POST/JSON API) | Not yet indexed → **`robots.txt` `Disallow` immediately**; already indexed → Phase 1 `noindex,follow` until dropped, Phase 2 `Disallow` | Canonical → parent (when fetched); strictly **excluded** from XML sitemap |
| **Tier D — Depleted / Zero-Item Combinations** | Filter or legacy facet returning **`0` matching items** | Remove internal links dynamically when count drops below threshold | Return real HTTP **`404`** (or `noindex,follow` if temporary seasonal stockout with restock ETA) | Never return `200 OK` empty shell (*Soft 404*) and never `301` blindly to homepage |

### Audit Acceptance Checklist
- [ ] Every multi-locale cluster passes 100% self-canonical + bidirectional `hreflang` + `x-default` parity with zero GeoIP `301/302` redirects.
- [ ] Log analysis filters crawlers via verified reverse+forward DNS (`PTR == A/AAAA`) or official CIDR ranges.
- [ ] Unchanged canonical URLs return `304 Not Modified` on `If-None-Match` / `If-Modified-Since` probes.
- [ ] Router enforces deterministic parameter ordering (`?a=1&b=2`) and blocks `>= 3` facet intersections from generating crawlable `<a href>` links.
