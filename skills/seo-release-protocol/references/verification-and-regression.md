# Fix verification and regression control

## Three-stage fix verification, regression control and audit log (pp. 83-153)

**Trigger:** Any technical fix, template or routing release

**Inputs:** Baseline metrics (indexed count, statuses, crawl frequency, CWV), Staging build, Control URL list

### Steps

1. Record the baseline and crawl staging to confirm the fix works without breaking canonicals, meta or statuses on neighboring templates.
2. Smoke test within hours of release: List-Mode crawl of the control list, 3-5 live inspections, headers, rendered DOM, robots.txt (within 5 min) and the sitemap.
3. After 7-28 days, check logs and Crawl Stats for fewer hits on blocked patterns and more on targets, and press Validate Fix in GSC Pages.
4. Log the outcome with 21-day After metrics in the versioned audit log, run the final checklist and set the new baseline.

### Decision rules

- A closed ticket is not a fix for search until all three stages pass.
- Keep a change log, because robots.txt overwrites, lost pagination self-canonicals and dropped schema come back after CMS updates or redesigns.

### Thresholds

- Smoke test 3-5 URLs
- Delayed check 7-28 days
- After metric at 21 days

### Checklist

- Post-release final checklist (6): no new chains, 404 spikes or 5xx; sitemap clean; canonical, hreflang, robots intact; mobile DOM complete; no crawl skew; no growing GSC buckets
- Audit log fields: task ID, date, template, defect, change, owner, before, after (21 d), status

### Anti-patterns

- Shipping without staging and smoke tests

### Human checkpoints

- Smoke test sign-off
- 7-28 day review and Validate Fix

### Tools

- Screaming Frog List Mode
- GSC
- log analyzer

### Feeds

- technical-readiness-gate
- seo-goal-check

**Output:** Verified release with an audit-log entry and a new baseline

**Done when:** All three stages pass and 21-day metrics are logged

## Pre-publication indexability gate for a new cocoon page (synthesized from chapter rules) (pp. 85-150)

**Trigger:** Before or right after exporting a page brief or page into site files

**Inputs:** Page URL and slug, Canonical parent from the architecture, Template, Locale cluster if any

### Steps

1. Confirm the URL is lowercase, follows the slash rule, has no parameters and fits the stable language-folder scheme.
2. Confirm it returns 200, has a self-canonical in raw head, has no noindex in raw HTML, and is not blocked by robots.
3. Confirm it has 2+ inbound HTML a-href links from its parent/hub and sits within 4 clicks.
4. Confirm main content, H1, links and JSON-LD are in server HTML, and mobile matches desktop.
5. Add it to the right child sitemap with an honest lastmod; add it to the hreflang cluster only once the translation is published.
6. Check that it doesn't duplicate an existing page's intent (cannibalization) and that thin pages meet the effort minimum.
7. After publishing, inspect the live URL in GSC; if it is not indexed after 10-14 days, run non-indexed-page-triage.

### Decision rules

- Pages that fail any access or directive check are not published.
- Pagination, parameter and facet URLs outside the whitelist never enter the sitemap or hreflang.

### Thresholds

- Depth ≤4 clicks
- 10-14 day indexing watch

### Checklist

- 200 / self-canonical / no noindex / open robots / inlinks / server-rendered content / in sitemap / unique intent

### Anti-patterns

- Publishing orphan pages
- Client-only content or schema

### Human checkpoints

- Owner confirms deploy access and GSC inspection

### Tools

- seo-agent
- chrome-devtools MCP
- google skill (GSC)

### Feeds

- non-indexed-page-triage
- seo-goal-check

**Output:** Pass/fail gate per page with fixes

**Done when:** All checks pass and the live inspection shows the page indexable

## Audit and freeze the release package scope (pp. 681-682)

**Trigger:** Before editorial work on a release package

**Inputs:** Approved research map, Candidates: mandatory, selected optional, deferred, excluded, Link and shared-fact dependencies

### Steps

1. Run /состав-пакета and reconcile the four groups with the approved map. Ask it to list docs with open questions without auto-excluding them, and to state what answers and transitions each deferral would remove.
2. Resolve links to unbuilt instructions: either include the target in this release or change the user route.
3. Make any page with open questions an explicit decision, recording the reason and the lost answers.
4. Give any optional page now included the full fact and content checks.
5. Keep shared-fact checks on all remaining pages even when another page that uses the fact is excluded.
6. After team approval, lock the scope with /заморозить-состав. Any later change requires an explicit revision with a reason.

### Decision rules

- A link to a future page doesn't count as a completed answer.
- Pages with open questions are never silently dropped to make the status look cleaner.

### Checklist

- Four groups reconciled
- Data supports each page's scale
- No reliance on unbuilt pages
- Deferrals documented with impact
- Shared-fact checks retained

### Anti-patterns

- Exempting optional pages from checks

### Human checkpoints

- Team discusses the package before setting statuses
- Approval before freeze; revisions need a recorded reason

### Tools

- Navigator
- /состав-пакета
- /заморозить-состав

### Feeds

- gist-page-brief
- stage-handoff-and-export

**Output:** Frozen scope in Navigator with deferral impact notes

**Done when:** Scope is frozen, no page leans on an unbuilt document, and every exclusion has a reason and impact

## Verify link context after editing and publication (pp. 668-694)

**Trigger:** Texts are drafted or edited, or pages are published

**Inputs:** Source and target texts, TGA link map, Live URLs

### Steps

1. An editor reads each paragraph without its link; if the reason for the transition disappears, revise the passage.
2. Run /перелинковка on the source and target texts: compare each adjacent claim, anchor and target answer, flag meaning shifts, and sort fixes into text edit, target replacement or link removal.
3. Check that the live HTML links exist, in a browser and with a crawler. Fragment links must open the intended section, not the top of the page.
4. Confirm the live anchors and targets still match the TGA link spec.

### Decision rules

- Tables, short instructions and UI elements are exceptions, judged case by case.
- TGA context-check numbers are internal checks; meaning and accuracy override them.

### Checklist

- Anchor fits its purpose
- Reason clear without the link
- Target still answers the claim
- HTML present
- Fragment scroll correct

### Anti-patterns

- Keeping a link after cuts moved its claim
- Treating the plan as proof the link is live
- Stuffing terms into anchors to satisfy a number

### Human checkpoints

- Editor read-through
- Browser check of the live page

### Tools

- X4
- /перелинковка
- browser
- crawler

### Feeds

- pilot-rollout-and-live-verification
- page-and-section-audit

**Output:** Validated link map and live link check

**Done when:** Claim, anchor and target align after edits, and live links and fragments resolve
