# Trust infrastructure and author hub — reference

Source: «SEO Монстр 2027» ch5 pp. 404–414, 428–436.

## Trust nodes (pp. 410–414)

Four documentation nodes, linked site-wide in footer and menu so the responsible entity is ≤1 click from any page (p. 411):

- `/about/` — legal name, registration codes, founding year, real photos, executive cards, license scans.
- `/contacts/` — separate legal, physical (map + entrance photo) and returns addresses; channels routed by scenario (new orders, warranty/refunds, accounting, complaints); anti-phishing block for banking, finance, law, medicine, major retail.
- `/customer-service/` — payment, shipping, returns, warranty, support SLA.
- `/legal/` — offer, data, terms, security.

Naming rule: brand, legal entity and domain identical character-for-character across title, H1, footer, user agreement and Organization schema (p. 411).

Product/service main content carries a compact shipping/return/warranty/safety summary linked to the full policies.

`/editorial-policy/` (pp. 431–433): source standards, review route, AI and human-in-the-loop declaration, corrections policy with 24–48 h error-verification SLA and public changelog, monetization separated from ratings. Linked near bylines and in the footer.

`/testing-methodology/` for reviews and ratings; affiliate and sponsored placements labelled.

`/help/` — indexable step-by-step guides built from frequent support questions.

External proof: verified maps/review-aggregator/registry widgets; contextual reviews (city, product, date, specialist, photo) instead of anonymous ones; quantified cases.

Post-click verification: cart, calculators, filters, booking, account work on mobile and desktop; snippet promise matches first-screen price/stock; no intrusive popups or ads disguised as navigation.

## Entity @graph (p. 434)

One JSON-LD @graph connecting by @id:

- `Organization` — publishingPrinciples → /editorial-policy/, correctionsPolicy → /corrections/, sameAs → verified external profiles.
- `Person` — worksFor, alumniOf, hasCredential, knowsAbout, sameAs.
- `Article`/`TechArticle` — author → Person @id, reviewedBy → reviewer Person @id, citation → sources.

Validate with Rich Results Test; every node must resolve via @id.

## Vertical mandatory elements (pp. 412–414)

| Vertical | Must have |
|---|---|
| E-commerce | details, contacts, delivery, returns, warranty, live price/stock, working cart, Product+Organization+MerchantReturnPolicy schema |
| Medical | licenses, doctor profiles, dual attribution (author+reviewer), review dates, guideline links, editorial policy |
| Finance/legal | practitioner registry numbers, transparent tariffs, statute links, cases with docket numbers |
| Media | editorial team page, corrections policy, changelog, methodology, ad labels |
| SaaS/B2B | pricing, cancellation and SLA, security docs, status page, cases, G2/Capterra |
| Local | unified NAP, map, facade and crew photos, service area, price list, GBP link |

Multi-branch: local phones, addresses and managers per branch.

Decision rules: pages asking for money/personal data without clear ownership and contacts → Lowest. Commercial, YMYL, SaaS and local sites need the full package; hobby blogs do not.

## Author profile spec (pp. 428–431)

- 1–3 narrow clusters per specialist (p. 430).
- Above-the-fold `dl` fact grid: relevant years, education, registry number, primary topic, editorial role, number of guides written and reviewed.
- Vertical credentials:
  - Medicine: specialty, accreditation, clinic, PubMed.
  - Law/tax: bar number, dispute category, anonymized rulings.
  - Reviews: methodology, instruments, devices tested, test-bench gallery, independence statement.
  - IT/media: GitHub, talks, standards work.
- Competence boundaries stated explicitly.
- Articles grouped by topical branch (Target and Mixed first) — not a chronological feed, not a 150-link paginated list.
- Title and H1: name + core specialization.
- Dated media citations, talks, working groups.
- Roles separated: author / reviewedBy / contributor (test engineer) / editor.
- ProfilePage JSON-LD → mainEntity Person (worksFor, alumniOf, hasCredential, knowsAbout); sameAs only to profiles matching name, photo, profession, company — exclude private/entertainment accounts.
- Article bylines clickable → `/authors/slug/`, with reviewer and revision date. Collective documents → named department → team page.

Anti-patterns: fictional personas with stock/AI faces; childhood-and-hobbies essays; one generic bio template across verticals; a profile confirmed only on-site (carries no weight); a claimed specialty with no registry record (expertise discounted).
