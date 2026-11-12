---
name: project-discovery-grill
description: >-
  Adaptive founder discovery interview and Living Project Passport engine: extracts verbatim founder voice alongside structured Epistemic Claims (confirmed, hypothesis, unknown, taboo) across 8 sections (Identity, Market & Locale Rails, Positioning, Audience JTBD, StoryBrand Voice, Unit Economics, BrandCore Proof, Product/Design Rails), flags fluff, multi-locale SEO traps, and market-channel clashes, and projects role-sliced context to all workflows. Use when: бриф проекта, паспорт проекта, интервью с основателем, старт проекта с нуля, описание ЦА и позиционирования, зарубежный рынок, «расспроси меня про проект», project passport, founder discovery. SKIP: personal owner biography for CV/year-review (profile-user / anamnesis); pure code bug triage (debug-investigate).
---

# Living Project Passport & Founder Discovery Grill

Used by `project-passport`, `passport.probe`, `passport.commit`, `seo-project-intake`, and `mkt-project-intake`.
Maintains two linked layers:
1. **Layer A — Verbatim Log (`.agents/passport/VERBATIM.jsonl`)**: exact founder phrasing, metaphors, pains, and taboos word-for-word.
2. **Layer B — Canonical `PassportV1` (`.agents/passport/PASSPORT.json` + `PASSPORT.md`)**: 8 sections where every claim carries `status: "confirmed" | "hypothesis" | "unknown" | "taboo"` and `evidence_ref`.

## When / do / when not

| When | Do | When not |
|---|---|---|
| Cold project from scratch (`idea_zero`) | Run `express` (2 rounds) or `deep_grill` (up to 5 rounds, 2–3 questions/round); tag guesses as `hypothesis` or `unknown` | Never invent fake metrics, reviews, or ICP facts |
| Existing repo / live site | Run `passport.probe` recon first; confirm inferred facts and ask only high-leverage gaps | Never re-ask facts already confirmed in `PASSPORT.json`, `BRANDCORE`, or `charter.json` |
| Non-RU or multi-locale project (`en-US`, `EU`, `LATAM`, `len(content_locales) > 1`) | Lock `market_rails` + URL topology (`subfolder | ccTLD | subdomain`), self-canonicals, reciprocal `hreflang`, and no GeoIP crawler redirects in Round 1 | Never leak RU defaults (`erid`, `152-ФЗ`, `+7`, `ЮKassa`, `Яндекс.Директ`) into non-RU projects |
| Domain graph lacks 2–3 fields | Run `domain_delta` for that domain | Personal CV / biography (`resume`, `year-review`) → `anamnesis` |

## Procedure

1. **Recon (`passport.probe`).** Scan `PASSPORT.json`, `README.md`, `PROJECT.md`, `VALUE-MAP.md`, `brandcore.md`, and `charter.json`. Run `python3 scripts/passport_grill_engine.py --input -` to score all 8 sections, detect fluff/contradictions, and pick the top 2–3 next questions.
2. **Contract (*Flawless Consulting* + *Trusted Advisor*).** Reflect the founder's core bottleneck in 1 sentence before probing numbers, state the mode (`express` or `deep_grill`), ask permission before sensitive unit economics, and remind them that «не знаю / пока гипотеза / хватит на сегодня» is valid at every step.
3. **Adaptive grill rounds (max 2–3 questions per turn):**
   - *Gate 1 — Identity, DDD Subdomains & Market Rails*: stage, `Core` secret sauce vs `Generic` buy-not-build (`identity.non_goals`), Ubiquitous Language (`domain_glossary`), locales, multi-locale URL topology (*The Art of SEO*), payments, compliance, taboos.
   - *Gate 2 — Positioning (*Obviously Awesome* 5+1 + *Ries & Trout*)*: status-quo workaround & its structural category weakness → unique attributes → provable value → best-fit ICP → single mental rung (`market_category`).
   - *Gate 3 — Switch & Buying Insight (*Mom Test* + *JTBD Four Forces* + *Revella 5 Rings* + *Schwartz Awareness*)*: trigger day, Push, Pull, Anxiety before paying, Habit, awareness (`unaware` → `most_aware`).
   - *Gate 4 — Voice, Brand Coherence, Persuasion & UX Rails*: StoryBrand SB7 + Ogilvy factual 5s Grunt Test, verbatim `owner_lexicon` & `banned_words`, Cialdini honest limitation admission (`anti_audience`), Wheeler signature touchpoints (`visual_references` vs `anti_references`), Patton Walking Skeleton steps (`core_jobs`), and Wiegers Quality Attribute Trade-off rank order (`constraints`).
4. **Anti-fluff & Contradiction check.** Challenge Sunday buzzwords with one past-behavior probe, and surface clashes (`MARKET_CHANNEL_CLASH`, `MULTILOCALE_TOPOLOGY_MISSING`, `GEOIP_REDIRECT_TRAP`, `GENERIC_SUBDOMAIN_REINVENTION`, `PRICE_MOTION_CLASH`, `PROOF_STAGE_CLASH`).
5. **Commit (`passport.commit`).** Append raw quotes to `VERBATIM.jsonl`, write `PASSPORT.json` + `PASSPORT.md` + `BRANDCORE.projection.md`, and sync L1 core summary.

## Deterministic gates

| Gate | Rule | Fail → |
|---|---|---|
| BATCH | ≤ 3 questions per human round + «save as is» exit (low Self-Orientation) | trim question batch |
| EPISTEMIC | unverified startup guesses carry `hypothesis`, unanswered carry `unknown` | downgrade unbacked `confirmed` |
| FLUFF | generic claims («for everyone», «для всех», «инновационный», «под ключ») | emit `fluff_warnings[]` + probe |
| RAILS | target/excluded countries, multi-locale URL topology, no GeoIP crawler redirects | emit `contradictions[]` |
| DDD / SKELETON | `Core` vs `Generic` buy-not-build (`non_goals`) + multi-step Walking Skeleton (`core_jobs`) | emit contradiction / follow-up |
| PROOF | `idea_zero` / `pre_launch_zero_proof` bans fake reviews and fake resetting timers | lock `forbidden_claims` |
| VERBATIM | founder answers stored word-for-word before structured extraction | block lossy overwrite |

## Output contract

`passport_path`, `passport_md_path`, `verbatim_path`, `brandcore_projection_path`, `completeness_score`, `confirmed_count`, `hypothesis_count`, `unknown_count`, `taboo_count`, `contradictions[]`, `fluff_warnings[]`, `next_questions[]`.

## Scripts

| Script | Job |
|---|---|
| `scripts/passport_grill_engine.py` | 8-section completeness & domain readiness scorer, fluff detector, cross-market / multi-locale / DDD / Walking Skeleton contradiction matrix, adaptive next-question selector, BrandCore/Charter projection builder (`--selftest`, `--fixture`, `--input -`) |

One JSON object per run, non-zero exit with a JSON error. `--help` first.

## References

- `references/mom-test-and-elicitation.md` — *The Mom Test*, *The Trusted Advisor*, *Software Requirements*, *User Story Mapping*, *Learning DDD*, *Flawless Consulting*.
- `references/positioning-awareness-and-strategy.md` — *Obviously Awesome* 5+1, *Positioning* (Ries & Trout), *Breakthrough Advertising*, Rumelt Strategy Kernel.
- `references/jtbd-four-forces-and-buying-rings.md` — *Competing Against Luck*, *When Coffee and Kale Compete* Four Forces, *Buyer Personas* 5 Rings.
- `references/storybrand-voice-and-global-rails.md` — *StoryBrand 2.0*, *Nicely Said*, *Designing Brand Identity*, Cialdini & Ogilvy honest persuasion, *The Art of SEO* multi-locale rails.

## Never

- Never sanitize or rewrite the founder's raw quotes in `VERBATIM.jsonl`.
- Never fabricate facts, case studies, or resetting countdown scarcity; record `unknown` or `hypothesis` and name the validation workflow (`web-research`, `research-dossier`, `spike`, `mkt-experiment-cycle`).
- Never dump a robotic 15-question form in one turn; reflect pain first and keep rounds to 2–3 sharp questions.
- Never allow RU-specific defaults (`RUB`, `+7`, `152-ФЗ`, `erid`, `Яндекс.Директ`, `Контур.Эльба`) to leak into a non-RU project, or GeoIP redirects to block multi-locale crawlers.
