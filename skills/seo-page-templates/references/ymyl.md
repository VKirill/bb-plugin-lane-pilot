# YMYL operational layout and experience packaging

## Classify a topic by cost of error and route it to the right production mode (pp. 419-422)

**Trigger:** Before any new query, topic or cluster enters the content plan; also when auditing a non-YMYL site for borderline risk zones

**Inputs:** Target query/topic or site semantic inventory, Roster of available authors, reviewers and their credentials, Owner statement on primary-data access

### Steps

1. Score the topic on the four harm-intake parameters: can an error cause physical, financial or legal harm; does it need statutes or scientific consensus; does the user expect actionable instructions; how fast do the rules go out of date.
2. Add the fifth test: would solving the problem in real life need a licensed specialist or an official agency rather than advice from a friend.
3. Judge risk by what the page promises and what the reader will do with it, not by whether medical or banking words appear.
4. Assign a tier: Basic, Moderate, YMYL Standard or YMYL Critical.
5. Assign a page role to each URL: Experience (first-person observation), Reference (primary regulations) or Directive (specialist advice).
6. Split mixed pages: keep personal experience and regulatory restrictions on separate, linked templates.
7. On non-YMYL sites, run a semantic scan for local risk pockets (DIY brakes or steering, diets and supplements, visas and customs, gas, electrical or structural work, child goods, credit, consumer returns, workplace safety) and rebuild those first instead of moving the whole catalog to strict mode.
8. If a hazardous subtopic has no accredited specialist and no primary data, apply Negative Scope: publish only a short navigation block that links to the official regulator.
9. Check vertical fit: block YMYL topics that sit outside the domain's established subject area.
10. Rewrite title, H1 and opening paragraphs so they carry no categorical or guaranteed promises and state the exact scope.

### Decision rules

- 2 or more of the 4 harm parameters triggered → move the page to the expert production pipeline.
- Directive pages are produced only if a verified domain specialist is on the project.
- Basic tier → standard editorial cycle based on the author's experience, own photos and comparison tables.
- Moderate tier → separate experience from regulatory reference, verify prices and terms, review every 6 months.
- YMYL Standard → specialist author, every claim tied to a law or standard, no clickbait, quarterly review.
- YMYL Critical → dual attribution (author plus licensed reviewer), Answer-First with contraindications on the first screen, primary registry links, immediate update when a norm changes.
- A commercial comparison or review, not a medical, legal or financial node → the evidence is your own test protocols, measurements and a disclosed affiliate model.
- A high-authority lifestyle domain publishing off-topic YMYL (investing on a gardening site) → expect no authority carry-over; do not publish.

### Thresholds

- Expert pipeline trigger: >=2 of 4 harm parameters (p.419-420)
- Negative Scope block: about 100 words (p.421)
- Review cycles: Moderate 6 months; Standard quarterly (p.422)

### Checklist

- Harm potential
- Need for regulatory or scientific backing
- Expectation of actionable steps
- Rate at which the rules go out of date
- Licensed specialist needed in real life

### Anti-patterns

- Detecting YMYL only by medical or banking keywords
- Hiding directive advice inside personal stories
- Guaranteed promises in title or H1
- A tiny footer disclaimer in place of scope boundaries in headings
- Generalizing from 'it worked for me' to 'everyone should do this'

### Human checkpoints

- Owner confirms which accredited specialists and primary data sources actually exist before any Directive page is planned

### Tools

- LLM classifier with the harm matrix as rubric

### Feeds

- claim-passport-registry
- ymyl-operational-page-layout
- tga-architecture
- gist-page-brief
- author-profile-hub

**Output:** Risk-tagged content plan: each topic has a tier, a page role (Experience, Reference or Directive), a production mode, and any Negative Scope decision

**Done when:** Every planned topic has a tier and role. No Directive page lacks an assigned specialist. Hazardous unbacked subtopics are reduced to regulator navigation blocks.

## Lay out a high-cost-of-error operational page (pp. 421-427)

**Trigger:** Creating or rebuilding a page in medicine, finance, law or technical safety

**Inputs:** Signed claim passport, Author and reviewer credentials, Vertical (medical, finance, law or technical safety)

### Steps

1. Give the URL one practical scenario only.
2. Put a verification bar above the H1: author, reviewer with degree or license, and last-reviewed date in a time element, all mirrored in schema (e.g. MedicalWebPage reviewedBy, lastReviewed).
3. Within the first ~300 words, give the direct safe answer with no filler (Answer-First), plus the document checklist and the limitations.
4. On the first or second screen, add a block on when the page does not apply and what is prohibited. By vertical: medicine lists comorbidities and age limits; finance lists non-resident or other tax regimes; law lists an expired limitation period or a different jurisdiction; technical lists missing grounding or work under pressure.
5. Order the first screens by vertical. Medical: a capsule with symptoms, red flags, contraindications and the right doctor. Finance: an instrument passport (who it is for, full cost, tax, risks, limits). Law: an applicability frame (jurisdiction, article, edition date, who it applies to, fee). Technical: emergency actions and prohibitions, then the regulation and the required permit group and protective equipment.
6. Structure the body into standard containers: regulatory base, step-by-step procedure, required documents, deadlines and fees, grounds for refusal, when an in-person specialist is needed.
7. Keep exact norms visually separate from expert interpretation, and put the inline Tier 1 link at the decision point.
8. Add a section of markers for when to consult a specialist, and a public changelog with dates and reasons.
9. Disable subscription popups, interstitials, sticky video players and layout-shifting ads.
10. Before publishing, scenario-test calculator formulas, form templates, registry links and fine print hidden behind asterisks.

### Decision rules

- Mixed pages (legal history plus theory plus bank comparison plus form instructions) → split them.
- Never dump all citations into a footer bibliography.

### Thresholds

- Upper operational tier: first 300 words; it serves about 80% of readers (p.425)

### Checklist

- Claim accuracy against current norms
- Accountability (author_id, publisher_id)
- Vertical reputation
- Interface safety: Answer-First, stable LCP/CLS/INP, low clutter
- Safety warning placed right before each risky step

### Anti-patterns

- Several screens of history before the answer
- Norms and commentary mixed in one paragraph
- Freshness faked by changing only the header date

### Human checkpoints

- Licensed reviewer sign-off
- Manual scenario test of calculators, templates and registry links

### Tools

- Schema.org MedicalWebPage / Article with reviewedBy

### Feeds

- page-pre-release-gate
- site-trust-infrastructure

**Output:** Published YMYL operational document with credentials, review date, safe answer and prohibitions above the fold, and no intrusive UI

**Done when:** The first screen shows credentials, review date, safe answer and prohibitions; all functional elements pass the scenario test; clutter scripts are off.

## Claim passport registry for YMYL pages (pp. 426-427)

**Trigger:** Before writing prose for any YMYL Standard or Critical page, and at each scheduled SLA review

**Inputs:** Target URL and scenario intent, Grounded fact map, Tier 1 primary sources, Assigned specialist and credentials

### Steps

1. List every key factual claim the document needs before any narrative is written.
2. For each claim record: Claim ID, target URL, exact wording, type (legal norm, clinical fact, calculation example or expert interpretation) and risk level.
3. Attach a Tier 1 source to each claim: code article with edition date, clinical protocol, or registry entry.
4. Assign the responsible expert (name and license or certificate number) and record the verification date.
5. Set the update SLA contour and list the related cocoon URLs that share the fact.
6. Centralize shared base norms and rates into 2-3 canonical internal reference hubs that scenario pages link to, instead of copying changeable facts onto every page.

### Decision rules

- Tier 1 sources (codes, clinical guidelines, registries, WHO/FDA protocols, Cochrane, PubMed) are mandatory for every key claim. Tier 2 industry analytics only adds context. Forums, unverified blogs, ad landings and media retellings are never proof.
- Outbound links to anonymous or untrustworthy sources pass a negative trust signal to the page.
- The passport is a separate artifact. It feeds GIST evidence cards later but is not GIST itself.

### Thresholds

- SLA: event-regulatory contour (key rates, exchange rates, visa rules, emergency amendments) within 24 hours of official publication; quarterly regular contour; 6 months for the fundamental reference contour (p.427)
- Canonical reference hubs per cluster: 2-3 (p.427)

### Checklist

- Claim ID
- URL
- Exact wording
- Claim type
- Risk level
- Tier 1 source with clause and edition date
- Expert with license number
- Last verification date
- Review SLA
- Related cocoon URLs

### Anti-patterns

- A flat once-a-year update schedule for all YMYL pages
- Duplicating changeable norms across scenario pages

### Human checkpoints

- The expert verifies and signs each passport row before drafting and at every SLA review

### Tools

- spreadsheet/registry
- alphaxiv for scientific sources

### Feeds

- ymyl-operational-page-layout
- gist-page-brief
- improvement-cadence

**Output:** Completed claim passport table and canonical-hub mapping for the URL

**Done when:** Every key claim has an ID, a Tier 1 source, an expert sign-off date and an SLA.

## Package first-hand experience as verifiable evidence (pp. 407-435)

**Trigger:** Authoring reviews, A-vs-B tests, repair or service walkthroughs, local guides, or hybrid Experience+YMYL pages

**Inputs:** Usage artifacts: duration, serial or firmware, tasks done, wear measurements, part costs, Manufacturer specs and instrument measurements, Original close-up and instrument-readout photos, watermarked logs, Support, warranty and complaint records

### Steps

1. Label the genre on the first screen: owner field experience, editorial test by methodology, reference manual, or expert-verified recommendation.
2. Embed usage artifacts in the main content paragraphs and tables.
3. Build a spec-vs-measured table: manufacturer claim against instrument reading, with stated temperature and load conditions.
4. For A-vs-B tests, test 2-3 competing products under identical load.
5. On hybrid YMYL topics, the experience holder writes the narrative and a licensed specialist verifies and signs contraindications, load limits and escalation triggers.
6. Turn real support and warranty cases into product Q&A and L3 support articles that answer long-tail questions.
7. Write a measurable author experience profile: role, years on the specific system, number of deployments.
8. Wrap original photos in figure elements with detailed figcaption.
9. Follow the chain: starting conditions → actions and tools → numeric result → limits of the method.
10. Publish /testing-methodology/ and disclose sample procurement and affiliate terms on comparisons.

### Decision rules

- Sensory, usability, logistics and everyday admin queries → prioritize Experience over degrees.
- Clinical, financial, legal, high-voltage, gas or structural prescriptions → require formal Expertise; experience alone is never enough.
- Without a real case → no first-person wording.

### Thresholds

- A-vs-B tests: 2-3 products (p.408)

### Checklist

- Genre label
- Usage artifacts in the text
- Spec-vs-measured table
- Figures with captions
- Conditions-actions-result-limits chain
- Disclosure of sample origin and affiliate terms

### Anti-patterns

- Opening with a bare claim that the editors tested the product
- Top-10 lists compiled from marketplace cards
- A sponsored review faking a personal test

### Human checkpoints

- A practitioner physically tests and measures; this cannot be delegated to an LLM

### Tools

- measuring instruments
- camera

### Feeds

- page-pre-release-gate
- author-profile-hub

**Output:** Experience-backed page with measurement tables, original media, specific author credentials and dual review on YMYL boundary sections

**Done when:** The experience is shown through measurements and original media that an LLM could not synthesize.
