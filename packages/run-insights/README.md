# @lane-pilot/run-insights

Reads what Lane Pilot already records about runs and turns it into three things a project can act on.

## Routing statistics

Which provider and model gets a task accepted at the first attempt, per task risk. Computed from
stage receipts: the `writer-agent` receipt names the provider and model, the `acceptance-receipt`
says whether and at which attempt the task was accepted.

| Export | What it does |
|---|---|
| `writerAcceptanceStats(db, {projectId?, since?})` | Rows of `providerId, model, risk, tasks, acceptedFirstTry, accepted, failed` |
| `recommendWriter(stats, {risk, minTasks?})` | The best pair for a risk with enough samples, or `null` |
| `routingHint(stats, current, risk)` | One sentence for the settings screen next to the writer picker |

## Lessons

Night review findings, rejected acceptances and failed verifications become memory candidates
for the `subagent` audience, so the next writer in the same area reads them before starting.

| Export | What it does |
|---|---|
| `collectLessonSources(db, {projectId, since})` | Receipts and attempt reasons worth learning from |
| `lessonCandidates(sources)` | Deduplicated `note` candidates with path and severity concepts |

## Rule proposals

A lesson that keeps repeating is a rule waiting to be written. Writer failures with the same masked
signature in three tasks become a proposal; the owner rewords and accepts it, and the host plugin
stores accepted rules where every writer reads them. Failures of the run machinery and of the PM's
plan are not proposed: a writer rule cannot prevent them.

| Export | What it does |
|---|---|
| `repeatedLessons(sources, {minOccurrences?, minTasks?})` | Groups of the same failure across tasks, one count per task |
| `upsertRuleProposals(db, projectId, lessons)` | New groups become `proposed`; known ones refresh counts, never wording or decision |
| `reviseRuleProposal` / `decideRuleProposal` | Reword while proposed; state changes by compare-and-swap |
| `acceptedRules(db, projectId)` | Accepted rules whose memory record still exists |
| `ruleMigrations` | The `lane_pilot_rule_proposal` table, appended to the host's migrations |

## Golden retrieval checks

A golden set is a list of queries with the record ids they must return. Run it after every memory
change; a drop in hit rate means retrieval, not the corpus, regressed.

| Export | What it does |
|---|---|
| `parseGoldenCases(raw)` | Validates `[{query, mustHit:[ids]}]` (also the YAML-like `query -> ids` lines lane-memory writes) |
| `runGoldenEval(cases, search)` | Hit rate and the misses per case |

## Who may use it

Lane Pilot settings and stages; a council that wants to know which models to trust for what.
Depends on `@lane-pilot/memory-core` for the candidate type and `better-sqlite3` types.
