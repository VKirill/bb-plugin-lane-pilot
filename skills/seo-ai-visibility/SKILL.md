---
name: seo-ai-visibility
description: >-
  Measure whether a brand and its pages are shown and cited inside AI answers (Alice AI, Google AI Overviews, ChatGPT, Perplexity): a question panel, paid SERP/AI collection under a budget, a citation matrix against competitors, 19 Agent Ready checks (llms.txt, SSR, schema, bot access) and a ranked diagnosis with orders. Use when: AI visibility, нейровыдача, цитирование в AI-ответах, Алиса AI, AIO, GEO/AEO аудит, llms.txt, «позиции стоят, а клики падают из-за AI-блока». SKIP: traffic drop after a core update (seo-update-forensics); full crawl/indexation audit (seo-tech-audit-kit); building third-party mentions (seo-linkbuilding-method).
---

# SEO AI visibility (GEO / AEO)

The method behind the `seo-ai-visibility` workflow. You measure, you do not rewrite pages: rewrites go out as orders
(`seo-page-refresh`, `seo-mentions`, `code_task`). Every number comes from a script output, never from a model guess.

## When / do / when not

| When | Do | When not |
|---|---|---|
| Baseline of a site's AI visibility, or a monthly recheck | Steps 1–6 below, mode `baseline` or `recheck` | The site has no indexed pages yet: run the tech audit first |
| Clicks fall while positions and the update calendar are flat | Mode `diagnose`: compare the AI-block share on the falling queries | A confirmed core update or migration in the window → `seo-update-forensics` |
| Owner asks «почему ChatGPT советует конкурентов» | Panel on the competitor's brand queries + citation sources | Reputation attack or fake reviews → `seo-trust-eeat` |

## Procedure

1. **Panel.** Build 60–150 audience questions from GSC/Webmaster queries, the brandcore entities and the competitor set:
   `python3 scripts/ai_vis_panel.py --input panel_in.json`. Navigational foreign-brand queries stay out unless asked.
2. **Budget first.** Estimate `queries × engines × runs`; reserve it in the api ledger (charter `api_cap_daily`). No reservation → stop.
3. **Collect.** `python3 scripts/ai_vis_collect.py --input panel.json --engine yandex --provider xmlstock --max-queries N --go`.
   Without `--go` the script parses fixtures only. Cache key = query + engine + region + device + date; a repeat inside 24 h is free.
4. **Score.** `python3 scripts/ai_vis_score.py --input runs.json` → presence share, citation share, «visible but not cited» pages,
   competitor share per question cluster.
5. **Agent Ready.** `python3 scripts/agent_ready_audit.py --input site_snapshot.json --strict` (or `--url` read-only GET):
   19 checks — llms.txt, robots for AI bots, SSR text parity, JSON-LD validity, canonical, speed of the first byte.
6. **Diagnose.** `python3 scripts/ai_vis_diagnose.py --input scored.json --top 10` → ranked tasks with the evidence row each.
   Turn them into orders: blocker → `code_task`; missing fact blocks / hub-spoke links → `seo-page-refresh`; sources the answers trust → `seo-mentions`.

## Deterministic gates

| Gate | Rule | Fail → |
|---|---|---|
| G1 panel size | 60 ≤ questions ≤ 150, every cluster ≥ 3 questions | rebuild the panel |
| G2 spend | reservation ok and `queries × engines × runs ≤ api_cap_daily` | stop, owner question |
| G3 sample | ≥ 2 collection runs on different days before any «we dropped» claim (AI answers vary run to run) | verdict `insufficient_runs` |
| G4 lag | GSC/Webmaster numbers only from the final window `[today−10d, today−3d]` | use the older window |
| G5 diagnose mode | clicks −18 % or worse, positions within ±1, no update in the window, AI-block share up ≥ 15 pp | not an AI-block case: hand to forensics |
| G6 publishing | orders that publish outside the site (reviews, PR, paid placements) need `owner_go == approve` | drop them, keep the rest |

## Output contract

`matrix_path` (citation matrix JSON), `panel_path`, `diagnosis_path`, `api_spent`, and `orders[]` (ActionOrder kinds
`code_task | sub_graph | specialist_handoff`). Each claim carries its source row: engine, query, run date, cited URL.

## Scripts

| Script | Job |
|---|---|
| `scripts/ai_vis_panel.py` | question panel from queries and entities |
| `scripts/ai_vis_collect.py` | paid SERP/AI collection (XMLStock / XMLRiver), `--go` to spend |
| `scripts/ai_vis_score.py` | presence and citation shares, competitor matrix |
| `scripts/agent_ready_audit.py` | 19 Agent Ready checks, `--strict` exits 3 on a critical miss |
| `scripts/ai_vis_diagnose.py` | ranked tasks with evidence |

Every script prints one JSON object; a non-zero exit carries a JSON error. Run `--help` before the first call, `--fixture` to dry-run.

## References

- `references/ai-visibility-tracker.md` — the tracker method (panel, runs, shares) and the Alice / AIO specifics.
- `references/geo-aeo-visibility-metrics.md` — metric definitions and what moves them.
- `references/technical-geo-agent-ready.md` — llms.txt, JS rendering, schema, share of voice in AI answers.
- `references/external-citations-serm.md` — third-party sources the answers rely on, adversarial defence.
- `references/agent-readiness-signals.md` — content signals that make a page citable.
- `references/06-internal-linking-and-geo-rag-evidence.md` — contextual hub-spoke internal linking (Book 1 Ch.9) and GEO/RAG passage extractability, EAV clarity, and epistemic limits (Book 2 Ch.6).

## Never

- Never report a visibility change from one collection run or promise deterministic LLM rank scores.
- Never treat leaked warehouse names (`Goldmine`, `siteRadius`) as exposed public metrics.
- Never call a paid collector without `--go` **and** a ledger reservation.
- Never rewrite a page from this skill; order it.
- Never quote a competitor's or a course's text longer than 25 words.
