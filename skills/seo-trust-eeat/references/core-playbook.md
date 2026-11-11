# seo-trust-eeat — Extended Playbook

## Procedures

### 1. Build the trust-node infrastructure (pp. 410–414, 431–434)

1. Split corporate documentation into four nodes: `/about/` (legal name, registration codes, founding year, real photos, executive cards, license scans), `/contacts/`, `/customer-service/` (payment, shipping, returns, warranty, support SLA), `/legal/` (offer, data, terms, security).
2. `/contacts/`: separate legal, physical (map + entrance photo) and returns addresses; route channels by scenario; anti-phishing block for banking/finance/law/medicine/major retail.
3. Link legal and policy pages site-wide — responsible entity ≤1 click from any page (p. 411).
4. Brand, legal entity and domain naming identical, character for character, across title, H1, footer, agreement and Organization schema.
5. Compact shipping/return/warranty/safety summary inside main content of product and service pages, linked to full policies.
6. `/editorial-policy/`: source standards, review route, AI + human-in-the-loop declaration, corrections policy with 24–48 h error-verification SLA and public changelog, monetization separated from ratings. Link near bylines and footer.
7. `/testing-methodology/` for reviews/ratings; label affiliate and sponsored placements.
8. `/help/` indexable section built from frequent support questions.
9. Verified external widgets/registries; contextual reviews (city, product, date, specialist, photo); quantified cases.
10. Verify cart, calculators, filters, booking, account on mobile+desktop; snippet promise matches first-screen price/stock; remove intrusive popups and disguised ads.
11. Connect Organization, Person and Article/TechArticle in one JSON-LD @graph via @id: publishingPrinciples, correctionsPolicy, hasCredential, knowsAbout, sameAs, reviewedBy, citation.

Post-click trust killers are fixed **before** any author or markup work. Vertical mandatory-element checklists: [references/trust-infrastructure.md](references/trust-infrastructure.md).

### 2. Build the author hub (pp. 428–431)

1. Assign each specialist to 1–3 narrow clusters only.
2. Above the fold: `dl` fact grid — relevant years, education, registry number, primary topic, editorial role, guides written/reviewed count.
3. Vertical credentials: medicine → specialty, accreditation, clinic, PubMed; law/tax → bar number, dispute category, anonymized rulings; reviews → methodology, instruments, devices tested, independence statement; IT/media → GitHub, talks, standards.
4. State competence boundaries — what they review and what they do not.
5. Group articles by topical branch (Target and Mixed first), not a chronological feed.
6. Title/H1 = name + core specialization (wins name queries).
7. Dated media citations, talks, working groups.
8. Separate roles in headers and markup: author, reviewedBy, contributor, editor.
9. ProfilePage JSON-LD, mainEntity Person: worksFor, alumniOf, hasCredential, knowsAbout; sameAs only to profiles whose name/photo/profession/company match — never private or entertainment accounts.
10. Clickable bylines → `/authors/slug/` with reviewer and revision date; collective documents → named department.

Rules: on-site-only confirmation carries no weight; a claimed specialty missing from the registry discounts the expertise; on a weak host fix main content first (procedure 4), not Person schema. Never invent credentials — owner supplies and confirms.

### 3. Audit E-E-A-T: real vs imitation (pp. 404–407, 416)

1. Record each template's trust basis: consumer testing, engineering practice, license, dealer status, warehouse/payment infrastructure.
2. Format must match responsibility — personal experience never styled as normative advice.
3. Named authors/reviewers with bio cards on informational, analytical and YMYL pages.
4. Transparency on every payment/lead/personal-data page: details, addresses, phones, refund rules.
5. isYmyl pages: cross-check every number, dosage, statute, calculation against primary databases pre-publication.
6. Disclosure blocks on reviews and ratings.
7. External reputation queries for brand, reviews, author names — excluding own domain (`-site:`).
8. Log systemic complaints (non-performance, hidden charges, falsification) as critical threats.
9. Walk the post-click path: no blocking banners, snippet promise = first screen, forms work.
10. Score imitation vs real on six axes: expertise inside text, author footprint, business proof, transparency, YMYL responsibility, post-click experience.

Judge by three data sets together: what the site says, what independent sources say, how well the page does its task. Factual errors, unsafe advice or hidden terms override credentials and fame. Five gate questions and audit detail: [references/eeat-audit-and-recovery.md](references/eeat-audit-and-recovery.md).

### 4. Recover trust bottom-up (pp. 415–417, 422–426)

Run stages strictly in order:

1. **Main content**: remove errors and filler; add methodologies, tables, original photos, boundary conditions, Data-Shift.
2. **YMYL add-on**: 410 for templated regional doorway clones and near-duplicates; split broad pages by jurisdiction; purge outdated dates/limits/forms/law editions from body text; bind claims to Tier-1 sources.
3. **UI hygiene**: remove interstitials and noisy sitewide blocks; fix cart/forms; sync snippets with first screen; purge bot-like traffic.
4. **Transparency**: publish legal details, refund/warranty rules, editorial policy, contacts.
5. **External verification**: standardize NAP in GBP and directories; gather detailed independent reviews; real specialists publish in industry media.
6. **Packaging**: author/reviewer cards, badges, connected JSON-LD graph.

Body text holding outdated facts fails freshness regardless of the header date. For drop triage that separates trust demotion from technical loss, pair with seo-update-forensics.

### 5. Bootstrap a young domain in 90 days (pp. 434–436)

1. Establish organization and author entities, sameAs-linked to practitioners with 5–10 years of external footprint.
2. Launch one narrow cocoon of 10–15 pages (1 Target + 3 Mixed + 8 Support); e-commerce: 1–2 niches.
3. Deploy vertical proof — medical: license scan, doctor cards with registry sameAs, doctor-author + chief-physician reviewer, one narrow cluster. Legal: one case category in one jurisdiction, bar numbers, won-case numbers, procedure guides, fee calculators. Finance: product-terms docs, full fee tables, disputes, regulator links, changelog, disclosed affiliate model. E-commerce/local: NAP sync, warehouse photos, dl specs, 15–20 external reviews. Affiliate (non-YMYL): physical testing, measurement photos, spec-vs-test tables, methodology. SaaS/B2B: API docs, help center, status page, security policy, SLA, migration guides.
4. Own the brand-verification queries: reviews, legal details, pricing, documentation, cancellation, alternatives.
5. Verify GBP and vertical directories; collect detailed reviews; link from `/contacts/`.

Rules: young non-YMYL is not penalized for lacking fame if content is good; young YMYL/transactional needs full transparency from day one; young affiliate without institutions avoids YMYL entirely. Forbidden: mass AI generation, fictional experts, bought reviews, YMYL text by generalist copywriters.

### 6. Operate GBP and route reviews (pp. 439–442)

- **Weekly**: phone line, open status, hours; answer all reviews and Q&A; 2–3 unretouched photos of real operations.
- **Monthly**: categories, prices, showcase, attributes; check third-party/competitor edits.
- **Quarterly**: mystery-shopper stress test (route, test call, website/booking links, UTM, load speed); review distribution across branches.
- **Same day** as any disruption: Google Posts + attribute update.
- **Incident reply** (6 elements): acknowledge incident + visit date; responsible department/role; QC contact with ticket number; investigation deadline; public follow-up on action taken; invite rating revision.
- **Review routing**: 2–4 h (or next day) after CRM order closes → personal link to that branch's review form and branch page; prompt to mention service, specialist, access.

Never pool reviews company-wide or ask for generic 5 stars. Pickup retail: warehouse hours, vehicle access, loaders, returns + Merchant Center local inventory feed.

### 7. Audit and fix the entity footprint; investigate poisoning (p. 718)

1. Lock canonical identifiers first: name, domain, variants, products, profiles.
2. Run Entity Footprint Prompt 1 (from seo-prompt-kit) only on supplied/found materials → confirmed attributes, conflicts with exact URLs and wording, missing data.
3. Company confirms which version of each conflicting fact is authoritative — a discrepancy does not show which is right. Flag gaps; never fill them.
4. Prompt 2 in the same chat → page edits, claim checks, profile syncs; plan new materials only where a basis exists. Execute and verify each action.
5. **Poisoning forensics**: collect mentions segmented by market/language/platform so namesakes are not mixed in; analyse recurring negative claims, conflicting descriptions, coordinated-publication signs; queue: pages to inspect, claims to check against company documents, legal/PR escalations. Disputed or coordinated items go to a lawyer or communications specialist after a document check.

## Output contract

Returns to the calling node: trust-node specs and policies; author hub specs; E-E-A-T audit report (trust basis per template, verified YMYL facts, reputation findings, post-click defects); remediation plan by stage; GBP change and reply drafts; entity footprint report + verified remediation plan; poisoning escalation queue.

## Called by

- `seo-trust` graph (wave 3): all procedures 1–7; feeds `seo-page`, `seo-release`, `seo-monitor`.

## Limits

- Owner supplies legal documents and confirms real credentials — never invent experts, numbers or reviews.
- Sending pitches, external publication and legal escalation are outward-facing and need human approval.
- GBP replies and review requests are drafts for a human to send.
