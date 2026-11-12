---
name: seo-tech-audit-kit
description: >-
  Technical SEO audit playbooks and thresholds from «SEO Монстр 2027» ch.2 and «The Art of SEO» 4th ed.: index-control directive choice, crawl budget protocol, verified Googlebot rDNS/fDNS log analysis, ETag/304 & Vary headers, spider traps, canonical sync, sitemaps, enterprise faceted crawl matrix, pagination, rendering parity, CWV, international URL topologies & hreflang, and Master Audit Matrix. Use when: технический аудит, tech audit, crawl budget, краулинговый бюджет, robots.txt, canonical, sitemap, hreflang, CWV, пагинация, не индексируется, фасетные фильтры. SKIP: release execution and migrations (→seo-release-protocol); page content rules (→seo-page-templates).
---

# SEO Tech Audit Kit

The technical gate and audit toolbox for an existing site. Knowledge only — it does not publish fixes; remediation items are handed to `seo-release`.

## When to use

- Technical readiness gate before content or link investment (pp. 60-64)
- Scheduled or regression technical audit; GSC shows crawl/index anomalies
- Choosing how to remove a URL from the index (noindex vs canonical vs Disallow vs 301/410)
- Crawl budget leaks, spider traps, parameter/facet bloat, pagination and infinite scroll
- JS rendering or Mobile-First parity failures; template-level CWV defects
- Multilingual hreflang architecture or audit
- robots.txt sanity check for WordPress / store / service site (Appendix 2, p. 728)

## Route to a playbook

1. **Gate first.** Run the 6-marker Crawl Health check and the GSC baseline → [crawl-budget-and-logs](references/crawl-budget-and-logs.md). If ≥2 markers fail, tech-first before content work.
2. **Index control.** Pick the directive per URL → [index-control-and-canonical](references/index-control-and-canonical.md). Includes the 5-contour canonical sync, the 9 override causes, the 5-level non-indexed triage, robots.txt lifecycle and the Appendix-2 quick check.
3. **Inventory hygiene.** Sitemap segmentation and governance, parameter registry, filter whitelist, duplicate audit, content pruning → [sitemaps-parameters](references/sitemaps-parameters.md).
4. **Lists and rendering.** Pagination 7-point audit, SEO-safe infinite scroll, raw-vs-rendered and mobile-vs-desktop DOM diff → [listings-rendering](references/listings-rendering.md).
5. **Speed, international topologies and faceted scale.** Template-level CWV (LCP/CLS/INP) & hreflang audit → [cwv-hreflang](references/cwv-hreflang.md); ccTLD/subfolder/subdomain trade-offs, self-canonical + reciprocal hreflang + zero GeoIP redirects, rDNS/fDNS bot verification, `ETag`/`304` + `Vary: User-Agent`, and 4-tier faceted crawl-budget matrix → [international-and-faceted-crawl-architecture](references/international-and-faceted-crawl-architecture.md).
6. **Aggregate.** Join crawler + GSC + log data into the Master Audit Matrix and prioritize defects (4 factors, P1-P4 routing) → [audit-matrix](references/audit-matrix.md).

## Core decision rules

- A site that works in a browser is not proof bots can crawl it — check bot access and parameter traps separately (p. 62).
- Junk URLs not yet indexed → Disallow now; already indexed in bulk → `noindex,follow` first, Disallow only after they drop out (pp. 62, 80).
- Redirect chains and loops must flatten to a single 301 hop (p. 105); the redirect work itself belongs to seo-release-protocol.
- Sitemap holds only 200-OK canonical indexable URLs with honest `lastmod`; >10k URLs → `sitemap_index.xml` split by template (pp. 63, 70, 96-100).
- Technical checks come before or alongside cocoon production: if crawl/render fails, content and links have no ranking effect (pp. 60-61).

## Output contract

The node returns: `tech-audit/{matrix.csv, backlog.md, robots.diff, sitemap-plan.md}` — the Master Audit Matrix rows, a defect backlog with P1-P4 tiers and team routing, proposed robots.txt diff, and the sitemap restructure plan. Every defect carries a template root cause, evidence source (crawler / GSC / logs) and a page reference. Fix tickets go to `seo-release`; delayed re-checks (10-14 days) go to `seo-monitor` via the SEO Change Log.

## Called by

- `seo-project-intake` node `tech_gate` (read-only snapshot, pass/tech-first verdict)
- `seo-tech-audit` graph (full audit to release tickets)
- `seo-structure-audit` graph (technical layer findings during restructure)

## Sources

«SEO Монстр 2027» ch. 2 (pp. 60-155) and Appendix 2 (p. 728). All rules paraphrased with page references; see the references/ files for full procedures, thresholds and checklists.

## Wave-2 Distilled References

- `references/screaming-frog-llm-embeddings-playbook.md` — operational playbook and thresholds.
- `references/technical-geo-llms-txt-js-schema-share.md` — operational playbook and thresholds.
- `references/indexing-gsc-and-indexnow-loop.md` — operational playbook and thresholds.
- `references/03-verified-logs-and-index-control.md` — verified log aggregation and crawl/index policy gates.
- `references/international-and-faceted-crawl-architecture.md` — *The Art of SEO* 4th ed. international URL topologies, `hreflang` + self-canonical + no-GeoIP-redirect invariant, verified rDNS/fDNS bot checks, `304 Not Modified` / `Vary`, and enterprise faceted crawl matrix.
