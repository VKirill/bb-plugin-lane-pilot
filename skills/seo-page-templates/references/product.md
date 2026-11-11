# Product detail page

## Product card: enrichment, variants, out-of-stock (pp. 164-269)

**Trigger:** When optimizing SKUs, setting up variants or handling out-of-stock

**Inputs:** SKU, MPN, GTIN-13 and attribute DB, demand per variant attribute, consumption formulas or compatibility lists, media and verified reviews

### Steps

1. H1: type, brand, series, model, defining attributes, factory SKU.
2. Buy Box: gallery, 5-6 specs, live stock, delivery cost and date for the user's city, warranty and returns, variant tiles, sticky add-to-cart on mobile.
3. Map each attribute to its context: a practical explanation next to the raw spec.
4. A consumption calculator or compatibility matrix, plus a table against 2-4 neighbouring models showing only the differences.
5. Applicability block (optimal for X, not for Y) and hard-limit warnings, with cross-sell links to required accessories.
6. Variants: variants without demand stay on one canonical URL. Variants with demand get their own URLs with unique H1 and title, linked by a-href tiles.
7. Out of stock: return 200, set availability to OutOfStock, offer a restock form, and show a carousel of in-stock alternatives within ±15% price under the H1.
8. Specs as a semantic table grouped by node. Product or ProductGroup (hasVariant, variesBy) with sku, mpn, gtin13, brand, offers, shippingDetails, hasMerchantReturnPolicy, and reviews only where visible.

### Decision rules

- Never return 404 or an empty page for a temporarily missing item.
- aggregateRating only when reviews show in the HTML and reviewCount is above 0.

### Thresholds

- Manufacturer text duplication of 95% marks the card as thin
- First-screen specs: 5-6
- Alternatives within ±15% price
- Neighbour table: 2-3 (p.268) or 3-4 (p.269) models

### Checklist

- 8 nodes: exact ID, visuals, commercial transparency, core specs, risk removal, UGC, CTA and alternatives, mobile stability with CLS and INP

### Anti-patterns

- Copied supplier cards
- 2,000-character generic SEO text
- Same store-wide FAQ on 10k cards

### Human checkpoints

- Original photos, infographics and expert warnings come from the owner

### Feeds

- schema-jsonld-graph
- media-slotted-alt-gallery
- original-visual-production

**Output:** High-effort product card

**Done when:** 8 nodes covered and Product JSON-LD valid, matching the page 100%

## Product detail page template: variants, semantic HTML and machine-readable layer (pp. 342-352)

**Trigger:** Building or upgrading a PDP template

**Inputs:** Market model name, specs with UN/CEFACT units, GTIN/MPN, Price, stock, shipping/return policy, Reviews, Q&A, media, stock verification time

### Steps

1. Variant policy: fold size, capacity and basic color variants without demand onto one canonical URL (canonical plus ProductGroup variesBy); give modifications that have their own query clusters or change core specs their own URL.
2. Segment the catalog: model-demand products get unique text, media, reviews and link priority; marginal products pass weight up to facets.
3. Synchronize URL, H1 and title around the market model name with no ERP codes.
4. Above the fold: price, stock, gallery, 5-7 key specs, buy button, delivery summary.
5. Put a 40-60 word factual answer capsule within the first 100 words; vary emphasis across base, mid and flagship tiers of a series.
6. Render the full spec table in visible HTML dl/dt/dd with PropertyValue microdata and unitCode.
7. Add JSON-LD Product with 30+ attributes (gtin, mpn, dimensions, shipping, return policy) that matches the visible values character for character.
8. SSR the first 3-5 reviews; add a Pros/Cons block mapped to positiveNotes/negativeNotes; figure/figcaption images; an ISO 8601 time tag for stock verification; 3-4 parameterized H3 Q&As generated from specs.
9. Links in four directions: up (breadcrumbs, clickable spec values to whitelisted facets), named 3-4 alternatives, compatible consumables, 1-2 cocoon guides.
10. Exclude non-canonical variants and 404/410 products from the sitemap.

### Decision rules

- Lifecycle rules are in inventory-driven-indexation-controller (p.344).
- Any mismatch between JSON-LD and visible values risks losing rich results (p.349).

### Thresholds

- 5-7 specs, 40-60 word capsule, 30+ attributes, 3-5 SSR reviews, 3-4 Q&As (pp.343,350-352)
- Book-cited tests: specs out of tabs +20% traffic (p.349)

### Checklist

- PDP verification checklist p.344

### Anti-patterns

- Specs hidden in JS tabs
- Manufacturer copy reused across a series
- Generic 'similar products' carousels
- JSON-LD only, with div soup in the HTML

### Human checkpoints

- Honest Pros/Cons and tier emphasis written by an editor (pp.343,351)

### Tools

- seo-agent
- structured data validator

### Feeds

- structured-data-markup
- technical-indexation-hygiene

**Output:** PDP template specification plus a validation script spec (raw HTML checks)

**Done when:** Raw HTML contains the capsule, dl specs with microdata, matching JSON-LD, SSR reviews, Pros/Cons, figures, a time tag and Q&As
