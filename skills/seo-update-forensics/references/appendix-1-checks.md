# Appendix 1 — post-update diagnostic checklist (checks 1-15)

Run after the update finished rolling out and ≥1 full week has passed (pp. 723, 725-727).

## Confirmation layer

1. **Drop confirmed** — ignore days 1-3; full week after end vs full week before start, weekday-aligned; ≥2 metrics down; large non-seasonal sites add 28 vs 28. Rule out holidays, news, season, sales, own releases.
2. **Segmentation** — brand vs non-brand, intent, template, device, search type, language, country, folder.
3. **Top losers** — export top 20-50 losing URLs three ways: click loss, impression loss, position loss with stable impressions. Look for the shared pattern.

## SERP layer

4. **SERP shift** — where impressions are stable but CTR fell: check AI Overviews, PAA, video, product, local blocks, especially on broad informational queries.

## Technical layer

5. **Index and canonical** — indexability; canonical Google selected vs declared; canonical agreement across HTML, sitemap, internal links; parameter/filter duplicates; canonical chains; cannibalisation.
6. **Crawl and access** — robots.txt blocks on pages or CSS/JS; 5xx, 404s; redirect chains; unexpected 302s; TTFB; Googlebot frequency in logs; sitemap freshness.
7. **Index bloat** — filters, sorting, UTM, print, tag, pagination, CMS duplicates.

## Content and trust layer

8. **Content vs winners** — task depth, H1-H3 structure, tables, examples, FAQs, original contribution vs the current SERP winners.
9. **Trust** — editorial policy, author and company transparency, above-the-fold ads/pop-ups, share of thin or duplicate pages.

## UX layer

10. **Post-click** — bounce spikes, falling engagement, returns to SERP, title-promise vs first screen, filler intros.
11. **CWV** — LCP, INP, CLS and TTFB by template and device, field and lab.

## Architecture layer

12. **Architecture** — internal links into affected URLs, breadcrumbs, orphans, intent overlap, informational→commercial bridges.
13. **Freshness** — substantive freshness (examples, UIs, laws, screenshots, products), not re-dated content. Fake `dateModified` is an anti-pattern.

## Response layer

14. **Hypotheses** — 3-5 main hypotheses, each with evidence (metrics, URLs, templates, competitors) and a layer label (technical / architectural / content / UX / trust / SERP change).
15. **Pilot** — limited pilot cohort; fix by layer; architecture and links before prose rewrites; monitor recrawling over 1-2 subsequent updates before scaling.

## Decision rules (pp. 725-727)

- Small moves inside top 10, unclear after a week → noise.
- Whole cluster 3-8 → 15-30 and staying → confirmed problem.
- No shared pattern among top losers → page-by-page diagnosis, no site-wide fixes.
- Drop confined to one locale/folder/template → document-class problem.
- Rule out canonical switch or split signals before blaming quality.
- Many weak pages → site-wide trust problem.
- CWV amplifies; it is not the whole explanation.
- Weak crawling slows quality recovery — fix both.
