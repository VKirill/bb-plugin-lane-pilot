# Category listing

## Category listing: 5-layer build (pp. 160-266)

**Trigger:** When creating or auditing an e-commerce category

**Inputs:** catalog DB (specs, stock, prices, ratings), whitelist of facet combinations with demand and inventory

### Steps

1. Mobile first screen: breadcrumbs, H1, one row of quick-tag chips, the first row of cards. Filters sit in a drawer.
2. Facets: only whitelist combinations get static a-href links, friendly URLs and self-canonicals. Sorts and multi-facet intersections stay in the UI and are not indexed. Empty filter results return 404.
3. Mini-cards: 3-4 key specs, price, stock, rating, buy and compare.
4. Default sort: popular, high-margin, in stock. Out-of-stock and on-order items go to the end of pagination.
5. Hub link blocks by use case, spec, budget and brand.
6. On page 1 only: a reference block with live count, price range, brands, a subtype table and 3-4 FAQs. Strip self-promotion boilerplate.
7. Dynamic title and description with count, minimum price and terms. Server-rendered BreadcrumbList, CollectionPage plus ItemList, FAQPage. Pagination pages get a self-canonical and the page number in the title.

### Decision rules

- Never mark a category as a single Product to get stars.
- Selection advice gives measurable thresholds, never vague qualities.

### Thresholds

- Mini-card specs: 3-4
- Subtype table: 3-5 columns
- FAQ: 3-4
- Navigator: 150-250 words, 4-5 rows, page 1 only

### Checklist

- 7 nodes: mobile first screen, sorting, mini-cards, filter management, cross-links, text hygiene, meta and JSON-LD

### Anti-patterns

- Bare grids
- SEO essays of 5-10k characters
- Products pushed to the 3rd-4th mobile screen
- A 1,500-word footer essay

### Human checkpoints

- Approve the facet whitelist

### Tools

- seo-tools (Wordstat)

### Feeds

- schema-jsonld-graph
- facet-filter-indexation
- template-rollout-cohorts

**Output:** Modular category page

**Done when:** All 7 checklist nodes pass

## Category (Target L1) listing layout and routing (pp. 314-336)

**Trigger:** Designing or refactoring a category template

**Inputs:** Product class name, price bounds, brands, Child L2 nodes, Bestseller and stock data, Comparison parameters, delivery/warranty terms

### Steps

1. Put an exact H1 above the fold, then a 2-3 sentence lead with assortment bounds, price range and key brands.
2. Above the grid, add an HTML preset block of static Daughter links to L2 nodes grouped by buyer criteria (material, brand, capacity, scenario).
3. Sort available bestsellers with full specs and reviews first, and out-of-stock items last.
4. Below the fold, add a compact comparison table of product types plus delivery, warranty and return terms.
5. Move long buying and care guides into cocoon articles and link them contextually; add a 3-4 Mixed-page navigator below the grid.
6. Give the category inbound links from the menu, child breadcrumbs and cocoon articles; remove noisy cross-catalog blocks; keep it at depth 3 or less; make sure the URL scheme can handle 10-50x assortment growth.
7. Prioritize the 15-20% of categories that drive revenue for homepage links, article links, hand-written snippets and LCP/INP monitoring.

### Decision rules

- A large category needs 3-5 child branches (p.336).

### Thresholds

- 2-3 sentence lead (p.335)
- Depth 3 or less (p.334)
- 3-5 child branches (p.336)

### Checklist

- Category pre-launch checklist p.336

### Anti-patterns

- Long history essays in the footer
- The category's only link sitting in the header dropdown

### Human checkpoints

- Manually check snippets and speed for the top 15-20% of categories (p.336)

### Tools

- seo-agent
- copywriter

### Feeds

- pdp-semantic-template
- commercial-investigation-chain

**Output:** Category template spec

**Done when:** Above-fold H1, lead and presets are live, in-stock-first sorting works, and guides are moved out
