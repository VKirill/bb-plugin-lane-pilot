# Service page

## Service page: commercial standard (pp. 168-267)

**Trigger:** When building or auditing a B2B or B2C service page

**Inputs:** anonymized sample deliverable, prices for 3 typical scales and calculator variables, symptom matrix and exclusions, 3-4 cases, 2-4 specialists

### Steps

1. First screen: segment, measurable deliverable, deadline and starting price, 3-4 bullets, a CTA that states the next step and response time.
2. Replace clichés with facts: contract deadlines, delay penalties, certifications.
3. Deliverables preview with a downloadable PDF sample.
4. Scope included in the base package versus add-ons, plus a step workflow with timelines and responsibilities.
5. Itemized costs for 3 typical objects, and a 3-4 parameter calculator that needs no phone number.
6. Symptom-to-solution matrix: sign, cause, method, cost.
7. 3-4 cases in the form baseline, task, work, quantified result, with 3-4 real photos and acceptance certificates.
8. Applicability limits naming the technical or budget boundary and an alternative package. 2-4 specialist cards. 4-6 contract FAQs. Service, Person and FAQPage JSON-LD.

### Decision rules

- If a buyer still has to call to learn price scope, method, timeline or past experience, the page fails.

### Thresholds

- 3 estimates
- Calculator: 3-4 parameters
- Cases: 3-4, with 3-4 photos each
- Specialists: 2-4
- FAQ: 4-6

### Checklist

- 6 buyer questions: what is delivered, applicability, process, scope, pricing, verifiable E-E-A-T

### Anti-patterns

- Price on request
- Blind name-and-phone forms
- Anonymous reviews
- Theory essays

### Human checkpoints

- Run the Next-Step-Without-a-Call test
- Real deliverables and certificates

### Feeds

- schema-jsonld-graph

**Output:** Fact-based service page

**Done when:** Passes the Next-Step-Without-a-Call test

## Proof layer: tagged cases, verified reviews, answer-first Q&A (pp. 360-365)

**Trigger:** Adding proof to service, sub-service and geo pages; 1-3 days after each completed order

**Inputs:** Completed project records, Order metadata and client contacts, Sales transcripts, support logs, CRM objections

### Steps

1. Store each case as an entity-dense report: object/model, location/street, problem plus error code, diagnosis, repair and part number, duration, cost, warranty.
2. Tag cases by service, brand/object, client industry and geo; show 2-4 matching cards (problem -> solution -> measurable outcome) on service pages, plus a 4-5 mini-scenario table; publish standalone /cases/ pages (1000-2000 words with diagrams) only for complex high-ticket projects, with a Mother link back.
3. Reviews: send a four-question survey 1-3 days after completion (initial problem, doubts, schedule/budget kept, result); attach meta (service, city, date, specialist, case link); add proof (stamped letter for B2B, external platform link for B2C); SSR the first 3-5.
4. Q&A: mine real questions from sales, support, CRM, cases and reviews; sort into four buckets (price, process, risks/warranty, applicability); answer in 40-70 words (direct answer with a figure, then conditions, then next step or link); use open HTML (H3 + p or dl) with no click-to-load accordions; write unique wording per page.
5. Keep corporate flagship cases and reviews on the home and About pages only; niche proof goes to its own sub-service or city.

### Decision rules

- A non-trivial concern found in a case becomes a new Q&A item (p.363).

### Thresholds

- 2-4 cards, 4-5 scenarios, 1000-2000 word standalone case, 3-5 SSR reviews, 40-70 word answers (pp.361-362)

### Anti-patterns

- Stub reviews and cases
- JS-only review widgets
- The same 5 reviews and FAQ on every page

### Human checkpoints

- Collect real client documents and confirm consent before publishing

### Tools

- gist-content-logic
- drmax-brandcore
- ru-check

### Feeds

- data-shift-scaled-pages
- eeat-proof-assets

**Output:** CMS case/review/Q&A records with tag schema and rendering rules

**Done when:** Every commercial page shows tag-matched proof in SSR HTML with no cross-site duplication

## Main service and sub-service hierarchy (pp. 353-356)

**Trigger:** Designing or restructuring service clusters

**Inputs:** Commercial demand per direction, Service catalog, technologies, objects, B2C/B2B segments, Prices, workflows, portfolio

### Steps

1. Choose one umbrella Main Service (Target L1) per direction: maximum demand, a market entity, a parent of scenarios, priority revenue.
2. Split sub-services (Mixed L2) only when there is a distinct task, multi-block workflow, dedicated cases/reviews/FAQ, own entities and own pricing or warranty; run the four-question self-competition filter (unique intent, scope difference, exclusive entities and cases, parent page).
3. Use customer wording in title/H1 and professional terms in H2s and body as QBST.
4. Build the eight Target blocks: first screen (H1, offer, base price, form); scope capsule; 4-8 sub-service cards with Daughter links; workflow; HTML price table plus cost factors; proof (2-4 cases, reviews, specialists, licenses); geography; Q&A.
5. Mixed pages: technology, error codes, parts, prices and cases, plus a second-screen list of when this sub-service is needed; Mother link in the first third.
6. Mirror the hierarchy in URLs, BreadcrumbList, body links and @graph.

### Decision rules

- Modifiers like cheap, price or urgent stay on the main page with a price table (p.355).
- A brand page that only swaps the heading is forbidden (p.356).

### Thresholds

- 4-8 cards, 2-4 cases (pp.355-356)

### Checklist

- Target designation p.354
- Sub-service eligibility pp.354-355
- Mandatory blocks pp.355-356
- Service architecture verification p.366

### Anti-patterns

- A dozen sub-pages with no hub
- A narrow special case as the root
- Jargon in H1

### Human checkpoints

- Owner confirms which sub-services have a real distinct workflow and pricing

### Tools

- topical-graph-architect
- gist-content-logic
- copywriter

### Feeds

- geo-landing-build
- service-proof-layer
- gist-page-brief

**Output:** Service cluster map and page specs

**Done when:** One Target per direction, distinct Mixed pages, and bidirectional links
