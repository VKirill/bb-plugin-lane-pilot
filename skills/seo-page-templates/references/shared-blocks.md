# Shared blocks: passport, content assembly, tables, snippets, media, schema

## Write the page entity passport and focus formula (pp. 207-275)

**Trigger:** Before drafting any new or complex URL

**Inputs:** intent card from serp-page-type-intent-fit, core user questions

### Steps

1. Fix one Central Entity per indexable URL. For a category or comparison, use one homogeneous group of objects.
2. Write the focus formula: this URL covers object X in scenario A, and not object Y or scenario B.
3. List 5-10 Supporting Entities: subtypes, components, standards, materials, compatible items, usage scenarios.
4. List the measurable attributes, parameters and units of the central entity, as entity-attribute-value triples.
5. List Tangential Entities, meaning neighbouring objects or funnel stages, to restrict or link out.
6. List 5-10 user decision questions (disclosure nodes) the page must answer.
7. Sort salient terms into three groups: mandatory base markers, enhancing expert markers, adjacent boundary terms used sparingly.
8. If the name is ambiguous (a brand, an abbreviation, a shared model name), plan disambiguation anchors: a generic classifier, the application domain, 3-4 unique attributes, and a Wikidata/registry URI for sameAs.

### Decision rules

- Content type sets the emphasis: product cards rest on specs and compatibility, service pages on regulations, tools and pricing, guides on cause and effect, steps and limits.
- Plan briefs around user questions, not character counts.

### Thresholds

- Central entities per URL: 1
- Supporting entities: 5-10
- User questions: 5-10
- Disambiguation anchors: 3-4 attributes within the first 50-100 words

### Checklist

- Central entity
- Focus formula
- Supporting entities
- Attributes and units
- Tangential entities to restrict
- Disclosure questions

### Anti-patterns

- Keyword-first or LSI stuffing in place of disclosing attributes
- Leaving the semantic centre undefined

### Human checkpoints

- Owner or expert confirms which scenarios are excluded and that the attributes are correct

### Tools

- topical-graph-architect
- Wikidata

### Feeds

- serp-semantic-gap-analysis
- main-content-assembly
- schema-jsonld-graph
- title-description-authoring
- gist-page-brief

**Output:** Entity passport (JSON/MD) per URL

**Done when:** The passport has one central entity, 5-10 supporting entities, measurable attributes, user questions and explicit exclusions

## Build the main content: core first, Answer-first modules, structured formats (pp. 172-264)

**Trigger:** When drafting or refactoring the main content of any template

**Inputs:** intent card, entity passport, gap report, verified domain data, norms and limits

### Steps

1. Put the Core at the top: the direct answer, key specs, formula or algorithm, price and terms. Put the Superstructure below it: edge cases, cases, downloadable checklists, FAQ.
2. Choose the article modification. A, short definitional lookup: 4 blocks (a 50-word definition, a formula or threshold mini-table, how to check it, links deeper). B, selection or setup guide: 8 zones (lead plus table of contents, criteria list, comparison table, A/B choice block, errors and limits, visuals, 3-5 H3 FAQs, author and cluster links). C, event or release: exact date, a summary of what changed, who is affected, an action plan.
3. For informational subtypes use these layouts. Factual: definition, norms table, edge cases. Procedural: prep checklist, numbered steps, mistakes. Comparative: a 7-10 parameter table above the fold and a choose-A-if/choose-B-if matrix. Diagnostic: a symptom, cause, check, fix table ordered from simple to complex.
4. Write each H2/H3 as one user question or subtask.
5. First sentence: a direct, measurable answer with numbers and conditions. Then 2-4 sentences of context and limits: why the norm applies, what happens if violated, when to use an alternative.
6. Reinforce with a table, a diagram or a 3-item list where the data compares things.
7. Put QBST terms in structural anchors: H2-H3, th cells, criteria labels, lead sentences, FAQ questions.
8. Put the central entity in title, H1, URL and as the subject of the first sentence. Repeat it, or its parts, in H2-H3 headings and table captions.
9. Add at least one Information Gain layer: your own measurements, working code, a calculator, an original diagram, or a breakdown of real errors.
10. Add a native commercial bridge and 3-5 contextual links to cluster pages. No aggressive ad banners in the middle of the text.

### Decision rules

- Keep a subtopic beyond the URL's intent to at most 2 sentences, then link it out.
- Comparison pages must be symmetric, with the same criteria for both objects.
- Do not insert sitewide promo banners inside passages, because they break Passage Indexing.

### Thresholds

- Lead: 2-4 sentences / 40-60 words; snippet-first answer 2-3 sentences
- Context after the thesis: 2-4 sentences
- Internal links: 3-5; author block links: 3-4
- FAQ: 3-5 H3 items
- A 4,000-character dense guide beats 15,000 characters of generic text

### Checklist

- Title promises a concrete utility format; H1 confirms it without copying the title
- One intent
- Answer-first plus a table of contents with #id anchors
- Every H2-H3 opens with a self-contained thesis
- Entity in strong positions; QBST in anchors
- An Information Gain layer
- Promised artifacts visible above the fold or via a jump link
- A/B choice rules, original figures, an author/reviewer card with dateModified

### Anti-patterns

- Character-count quotas
- Filler openers and repeated theses
- Essay structure of intro, musings, conclusion
- Total Coverage of the whole topic on one URL
- Asymmetric A-vs-B pages

### Human checkpoints

- A real author or reviewer with verifiable credentials
- Field notes and real photos from the practitioner

### Tools

- gist-content-logic
- drmax-text-humanization

### Feeds

- content-pruning-drift-cleanup
- semantic-html-table
- extractable-snippet-units
- title-description-authoring
- schema-jsonld-graph
- media-image-markup

**Output:** Draft main content with modular H2-H3 blocks, tables and artifacts

**Done when:** Every block supports the target action, the lead and every H2 open Answer-first, and the content passes content-pruning-drift-cleanup

## Build machine-readable comparison and spec tables (pp. 203-232)

**Trigger:** When the page compares 3 or more objects on 3 or more criteria, or shows norms, prices or specs

**Inputs:** entities (rows), attributes with units (columns), normalized values, the selection question

### Steps

1. Scope each table to one question: 3-5 columns by 4-8 rows. For big datasets put a Top-5 by 4 criteria summary first and the full table below or in a tab.
2. Mark it up with table, caption, thead, th scope=col, tbody, th scope=row for entity names, and td for data. No colspan or rowspan.
3. Put units in the headers and use one notation per column. Replace marketing claims with numbers.
4. Frame it with an H2/H3 phrased as the target question, a 1-2 sentence intro naming the items and criteria, and a 2-3 sentence conclusion that states a selection rule.
5. On mobile, wrap it in an overflow-x:auto container and make the row header sticky. Never use display:block on table elements.
6. Pair it with page-level JSON-LD: ItemList for a category or rating, Product/Service for commercial pages, Article plus FAQPage for guides, Dataset for original research.

### Decision rules

- Use a table matrix for 5-8 strict parameters, Pros-vs-Limitations cards for two approaches, and choose-A-if blocks for scenario decisions.
- Cost queries: a 2-sentence price range with 3 pricing factors, then a 4-5 row tariff table.

### Thresholds

- 3-5 columns, 4-8 rows (snippet tables up to 6-7 rows)
- Intro 1-2 sentences; conclusion 2-3 sentences

### Checklist

- Real table element, not a div grid
- caption, thead, tbody and th scope present
- One question per table
- Heading, intro and conclusion
- Units in headers
- Normalized values
- Facts, not adjectives
- Compact size
- Mobile horizontal scroll

### Anti-patterns

- Div or CSS grid tables
- 18x50 mega-tables
- Vague headers such as Misc
- Mixed units
- Hiding tables on mobile

### Feeds

- schema-jsonld-graph
- extractable-snippet-units

**Output:** Semantic HTML table block with its context frame

**Done when:** All 9 items of the table extraction checklist pass

## Build extractable units for Featured Snippets, AI citations and the AEO FAQ (pp. 217-232)

**Trigger:** When targeting position zero, AI Overview inline or Dive Deeper citations, or a FAQ for answer engines

**Inputs:** target query, live SERP format, draft HTML, PAA, GSC question queries, marketplace Q&A, support logs

### Steps

1. Check in incognito which snippet format Google shows now: paragraph, ol, ul, table, or video with timecodes.
2. Build a unit that matches it. Paragraph: 40-60 words (250-350 characters), the term in strong, numbers in the first 50 words. List: 4-8 items (7-10 to trigger truncation), each starting with a bold label and a colon. Table: 3-5 columns by 4-7 rows.
3. Put a question-matching H2/H3 directly above it. Start with a direct statement and no backward references.
4. Isolation test: paste the heading and answer into a blank file and confirm it reads on its own, with no dangling pronouns.
5. For the FAQ, pull real follow-up questions from PAA, GSC (question-word regex), marketplace Q&A, reviews and support logs. Drop the basic definitional ones.
6. Place the FAQ in the bottom third of the page as H3 plus p, 2-4 sentences each, opening with a self-contained answer that contains a number or condition. Promote any long answer to its own H2.
7. Optionally add FAQPage JSON-LD for external AI crawlers. Check it in Schema Markup Validator.
8. Remove boilerplate from snippets: add data-nosnippet to cookie notices, disclaimers, filter widgets and header contacts.

### Decision rules

- Format by query type: definition gets a p, steps an ol, criteria a ul, multi-parameter choice a table, A-or-B a 1:1 table plus a choice block, diagnosis a cause-to-fix list from most to least frequent, price a range paragraph plus a tariff table.
- Use ol when order matters and ul for equivalent criteria.
- Step lists start under an H2 with a task verb and one sentence stating the outcome.
- Comparison blocks go mid-page, after the options are introduced.

### Thresholds

- Paragraph 40-60 words
- List 4-8 items
- Table 3-5 x 4-7
- FAQ answer 2-4 sentences
- Lead text window 150-200 words

### Checklist

- Matches the live SERP format
- Within the size limits
- Passes the isolation test
- FAQ in the bottom third
- No duplicate-topic questions

### Anti-patterns

- Bullets of 1-2 words
- Filler first sentences in FAQ answers
- Templated FAQ copied across thousands of cards
- Merged table cells

### Human checkpoints

- Run the isolation test on candidate blocks

### Tools

- GSC regex filter
- Schema Markup Validator

### Feeds

- schema-jsonld-graph
- gsc-snippet-ctr-audit

**Output:** Extractable HTML units and an AEO FAQ block

**Done when:** Every unit matches the SERP type and the limits, passes isolation, and the FAQ validates

## Content image markup, delivery and hero image (pp. 237-247)

**Trigger:** When adding or updating any content image or article cover

**Inputs:** image, object, model and attributes, nearest H2-H3 and paragraph

### Steps

1. Pre-check on 4 questions: semantic function, intent fit, textual context, originality. 2 or more failures: replace or remove.
2. Alt of 6-14 words: object and model, angle or node, significant detail. Decorative images get an empty alt.
3. figure with a figcaption stating the conclusion, measurement, warning or revision, placed beside the paragraph it proves.
4. WebP or AVIF (SVG for vectors) at 80-150 KB, a descriptive transliterated filename, srcset and sizes, width and height. fetchpriority=high above the fold, lazy loading below.
5. ImageObject JSON-LD: contentUrl, width, height, caption, creditText, creator, license.
6. Hero: 16:9 at 1200x675 or more, a concrete close-up subject, no small text, split-screen with red and green markers for A-vs-B or mistakes articles, and max-image-preview:large.

### Decision rules

- Commercial pages: multiple angles, macro shots, dimension drawings, in-use shots.
- YMYL or expert pages: your own process and test photos as proof of experience.

### Thresholds

- Alt: 6-14 words
- 80-150 KB
- Width 1200 px or more
- CLS 0
- 3 functional images beat 12 stock ones

### Checklist

- Technical image checklist (6 items)
- Discover/AI Overview cover checklist

### Anti-patterns

- Stock images
- Keyword spam in alt
- Cloned alt text
- Default camera filenames

### Human checkpoints

- Context test: hide the body text and the logic should still be clear from headings, images and captions

### Feeds

- schema-jsonld-graph
- vision-llm-media-audit

**Output:** Marked-up figure blocks and a hero image

**Done when:** Context test passes and the technical checklist is green

## Slot-based dynamic alt for product galleries (pp. 241-242)

**Trigger:** When configuring CMS alt generation for large catalogs

**Inputs:** DB attributes, gallery slot order 1-5

### Steps

1. Standardize slots: 1 front or 3/4 view, 2 controls or ports, 3 internals, 4 box contents, 5 dimension drawing or scale.
2. Bind one attribute formula to each slot. Slot 1: type, brand, model, colour, material. Slot 2: key feature. Slot 3: components. Slot 4: contents plus SKU. Slot 5: HxWxD in mm and weight in kg.

### Thresholds

- 5 slots

### Checklist

- No duplicate alts
- No photo-1 suffixes
- No spam words

### Anti-patterns

- Category name used as alt

### Tools

- CMS

### Feeds

- template-rollout-cohorts

**Output:** Unique alt per slot

**Done when:** Every gallery image has a distinct alt driven by attributes

## Content-first JSON-LD @graph: design, generation, validation, rollout (pp. 249-261)

**Trigger:** When adding or updating structured data on a page or CMS template

**Inputs:** finished visible content, entity passport, CMS field map

### Steps

1. Finish the visible content first.
2. Choose the narrowest @type for the page role. Article, product, product group, category, review, local, homepage and tool pages each have their own type; see decision_rules.
3. Build one SSR @graph from Organization, WebSite, WebPage, BreadcrumbList, the main entity and Person, joined by #id references. The Organization @id stays the same on every page.
4. Add about, mentions and sameAs (Wikidata or registries) for the main entity. Person nodes get jobTitle, url and sameAs. The publisher logo is an ImageObject.
5. Generate the CMS template with an LLM that uses only visible data and sets no invented values. Add a conditional to hide aggregateRating when reviewCount is 0.
6. Check the critical fields by hand: rating and reviews, price and availability, breadcrumbs, dates, author and publisher URLs, address and geo against GBP, sameAs.
7. Run the Rich Results Test and the Schema Markup Validator.
8. Monitor GSC Shopping, Enhancements and Manual Actions for 7-14 days.

### Decision rules

- Article (or a narrower subtype) for editorial pages; Product plus Offer, with shippingDetails, hasMerchantReturnPolicy, gtin, mpn, sku and an image array, for products. ProductGroup with variesBy and hasVariant for variants; CollectionPage plus ItemList for categories.
- Review with positiveNotes and negativeNotes for independent reviews with no Offer; the narrowest LocalBusiness subtype for branches; Organization with legalName, taxID, contactPoint and sameAs for the homepage or About page; WebApplication for tools.
- FAQPage and HowTo serve only as AEO markup, since Google switched off their visual results. Do not spend effort on the other deprecated types.
- No self-serving ratings on Organization or LocalBusiness.
- JSON-LD is server-rendered, never injected through GTM.
- Markup clarifies the entity and lifts CTR. It will not rescue a weak page.

### Thresholds

- 100% match with visible content
- aggregateRating only when reviewCount is above 0
- price is a bare number; currency in ISO 4217; dates in ISO 8601 with timezone
- Monitoring window: 7-14 days

### Checklist

- Penalty-free conditions (3 items)
- LLM/RAG discipline (3 items)
- Pre-release field audit (7 items)

### Anti-patterns

- Marking up hidden content
- Mismatched @type
- Stale prices or daily date bumps
- Several disconnected script blocks
- Invented GTINs, ratings or coordinates
- Looking for a special AI-only schema vocabulary

### Human checkpoints

- An SEO specialist audits the fields by hand before release

### Tools

- Rich Results Test
- Schema Markup Validator
- GSC

### Feeds

- template-rollout-cohorts
- single-landing-page-route

**Output:** Validated server-rendered @graph template, monitored in GSC

**Done when:** Both validators return zero errors and GSC is clean after 7-14 days

## Pre-release utility gate and pre-optimization content gate (pp. 396-402)

**Trigger:** Before publishing any new page, and before any link boosting, title tuning or JSON-LD task is scheduled for an existing URL

**Inputs:** Target URL content or draft, Neighboring URLs in the same cluster, Cluster QBST term core and fact matrix, Base LLM with no external data

### Steps

1. Intent check: the page serves one dominant intent and does not mix incompatible formats (e.g. glossary plus catalog grid plus repair guide).
2. Effort check: the page has its own factual or instrumental layer, such as measurement tables, quantified cases, calculators, diagrams, local observations, error breakdowns, decision matrices or regional Data-Shift.
3. Replaceability check: if stitching together three paragraphs from top competitors would give the same value, the page has zero Information Gain.
4. Replicability stress test: prompt a base LLM with no external or company data to write the same piece, then compare factual density, argument and depth. If it barely differs, mark the page maximally replicable.
5. Differentiation check: the page differs from neighbors in user task, entities and QBST core and fact matrix by at least 60-70%.
6. Hierarchy check: the page receives and passes contextual links to its parent and child nodes and holds an explicit Target L1, Mixed L2 or Support L3 role.
7. Freshness check: the page contains concrete parameters, prices, dates, regulatory references or model lines that will be reviewed regularly.
8. Gate decision: if any of the intent, effort or differentiation checks fails, block link, title and schema tasks and route the URL to reconstruction or a 301 merge. If all pass, unlock link reinforcement, snippet polishing and extended JSON-LD.

### Decision rules

- Technical SEO only multiplies content value, so a thin page that is fast, valid and well linked is rejected faster at index selection. Keep technical bugs and content deficits in separate backlogs.
- A weak page pushed into the top 10 by links and a clickbait title collects pogo-sticking and drops out.

### Thresholds

- Inter-page differentiation >=60-70% by QBST core and fact matrix (p.399)

### Checklist

- Single intent
- Own factual layer
- Not stitchable from competitors
- Distinct from neighbors
- Embedded in the hierarchy
- Built-in update potential

### Anti-patterns

- Endlessly rewriting title, H1 order, JSON-LD and breadcrumbs on a shallow page
- Mixing 5xx fixes and content deficits in one backlog

### Human checkpoints

- Editor confirms the gate verdict before technical or link tasks enter the sprint

### Tools

- base LLM
- embedding similarity
- crawler

### Feeds

- page-utility-enrichment
- merge-301-protocol
- internal-linking-linkvalue
- cocoon-audit

**Output:** Gate verdict per URL: approved for technical and link scaling, or routed to reconstruction or merge, with reasons

**Done when:** Every URL has passed all three content checks before any technical or link task is queued.
