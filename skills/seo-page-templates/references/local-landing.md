# Local landing page

## Local landing page: differentiation and geo-integration (pp. 175-255)

**Trigger:** When launching city, district or metro pages

**Inputs:** presence model per location, carrier schedules, tariffs, terminals, 12-month order counts, regional geology, climate or regulation data, geo-tagged cases and reviews; NAP

### Steps

1. Classify each location as a Physical Branch or a Delivery/Service Zone. Never invent addresses.
2. Zones: shipping days, next arrival, tariffs, 8 or more pickup points, local order statistics, or a district engineering table for 15-20 settlements.
3. Branches: distance and minutes from transit stops, entrance photos, parking, local staff schedules.
4. 3-4 geo-filtered local cases with micro-toponyms.
5. Match NAP and hours exactly with GBP, Yandex Business and 2GIS. The GBP link points to the branch URL. LocalBusiness subtype JSON-LD with address, geo, hours, hasMap or areaServed.

### Decision rules

- If the page becomes indistinguishable once the city name is removed, do not index it until it is enriched.

### Thresholds

- Index Selection drops 80-90% of clone geo pages
- Cases: 3-4
- Settlements: 15-20

### Checklist

- Uniqueness test: what the user learns about their city beyond its name

### Anti-patterns

- City-name-swap clones
- Fake branch addresses

### Human checkpoints

- Run the uniqueness test
- Real entrance and parking photos

### Tools

- GBP
- Yandex Business
- 2GIS

### Feeds

- schema-jsonld-graph
- local-seo-gbp-sync

**Output:** Geo-unique local page

**Done when:** Unique data stays when the city name is removed from the headings

## Geo-targeted service landing pages (pp. 357-365)

**Trigger:** Scaling a location-dependent service across cities, districts or suburbs

**Inputs:** Regional demand and SERP localization, Central NAP registry, service areas, tariffs, Local cases and geotagged reviews

### Steps

1. Gate each location: demand (toponym or localized SERP), a real branch or crew, changed terms (fee, arrival time, hours), local proof.
2. Pick the URL pattern: /service/city/ for 1-2 specialties across many towns, /city/service/ for full multi-service branches; use subfolders, not subdomains, for SMBs.
3. Pull NAP from the central CMS registry so HTML, JSON-LD and GBP match character for character.
4. Page blocks: localized first screen (H1 with place, arrival time, fee); 4-6 logistics parameters; local building stock with named complexes; 2-3 local street cases; geotagged reviews; NAP with photo and route map.
5. Stationary branch: address, facade photo, metro, parking, hours, LocalBusiness with PostalAddress/Geo/hasMap. Mobile service-area business: dispatch base, arrival-time standard, zone map, areaServed with Wikidata @id.
6. Links: up to the main service, down to local sub-services, sideways to 3-5 nearest locations.
7. List geo pages in a dedicated sitemap-locations.xml.

### Decision rules

- A settlement with no demand and no cases gets no URL; list it in the district page's coverage block (p.365).
- No lexical variants of the same service in the same city (p.365).

### Thresholds

- 4-6 logistics parameters, 2-3 cases, 3-5 neighbors (pp.359-360)

### Checklist

- Geo eligibility p.357
- Geo mandatory blocks pp.359-360

### Anti-patterns

- A 200-city link footer
- A single national page in local niches
- Regional subdomains for an SMB

### Human checkpoints

- Verify physical presence and collect authentic local evidence (pp.357,360)

### Tools

- seo-tools
- google (GBP/GSC)
- yandex (Webmaster)

### Feeds

- data-shift-scaled-pages
- service-proof-layer
- local-seo-gbp
- structured-data-markup

**Output:** Geo pages with LocalBusiness + Service @graph and a sitemap-locations.xml

**Done when:** Each page passes the eligibility gate and has verified NAP, local blocks, valid JSON-LD and neighbor links
