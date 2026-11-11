---
name: seo-release-protocol
description: "Safe SEO change protocol from «SEO Монстр 2027»: three-stage fix verification and regression log, site migration and single-hop redirects, template cohorts with override locks and split tests, MVC batch release and wave rollout with control pauses, bounded pilot slice and live scenario QA. Use when: релиз, миграция, редиректы, выкатка шаблона, release, migration, 301, template rollout, pilot, регрессия. SKIP: finding the defects (→seo-tech-audit-kit, seo-update-forensics); page specs (→seo-page-templates)."
---

# SEO Release Protocol

The only place a site changes. Everything upstream (tech audit, cocoon, page, refresh, structure audit) produces release items; this protocol says how to ship them without losing rankings.

## When to use

- Publishing any batch of changes from an audit, cocoon or template rollout
- Domain/host/CMS migration or URL restructuring
- Mass template changes to a catalog or service/geo matrix
- Verifying that a shipped fix actually landed and did not regress

## Route to a playbook

1. **Before release.** Freeze scope, run the pre-publication indexability gate, verify link context → [verification-and-regression](references/verification-and-regression.md).
2. **Choose the rollout shape.**
   - Template change at scale → cohorts with CMS override locks and a test/control split (pp. 262-276) → [rollout-waves](references/rollout-waves.md)
   - New cluster or restructure → MVC batch release in waves with control pauses (pp. 379-391) → [rollout-waves](references/rollout-waves.md)
   - Bounded pilot before a big cocoon → pilot slice with baselines and live scenario QA (pp. 693-696) → [rollout-waves](references/rollout-waves.md)
   - Migration or URL moves → six-source inventory, 1:1 redirect map, single-hop rules, Change of Address, weekly verification → [migration-and-redirects](references/migration-and-redirects.md)
3. **After release.** Three-stage verification (immediate, 10-14 day, monthly), regression control, append to the audit log → [verification-and-regression](references/verification-and-regression.md).

## Core decision rules

- Every redirect resolves to the final canonical URL in **one** 301 hop; chains and loops are flattened before or during release (pp. 105-106).
- A migration without a complete 1:1 old→new map is not shipped; List-mode staging test comes before DNS/launch (pp. 103-108).
- Template rollouts never hit 100% of pages at once: cohort first, override fields locked, split test measured before the next wave (pp. 270-276).
- Delayed checks never wait inside a run: write a due date into the SEO Change Log; `seo-monitor` starts the follow-up when it passes.
- If verification fails, roll back to the previous template/config state and log the regression — do not patch forward blindly (pp. 152-153).

## Output contract

The node returns: shipped release items with their cohort/wave assignment, the redirect map (`old → new`, single hop), the Change Log entries with due dates, and the verification log (what was checked, when, verdict). Unverified or regressed items come back as new release items or rollbacks.

## Called by

- `seo-release` graph (all modes: publish, migration, index_check)
- `seo-template-scale` graph (output rolled out by cohort through seo-release)
- `seo-structure-audit` graph (pruning/301 packets ship only through seo-release)

## Sources

«SEO Монстр 2027» ch. 2 (pp. 103-109, 147-155), ch. 3 (pp. 262-276), ch. 4 (pp. 379-391), ch. 8 (pp. 691-696). Paraphrased with page references; details in references/.

## Verified Scripts

- `scripts/indexnow_push.py` — deterministic CLI check (`--fixture` / `--input`).
- `scripts/release_graph_sim.py` — deterministic CLI check (`--fixture` / `--input`).

## Wave-2 Distilled References

- `references/indexing-gsc-and-indexnow-loop.md` — operational playbook and thresholds.
- `references/04-url-sitemap-and-mobile-regression.md` — operational playbook and thresholds.
