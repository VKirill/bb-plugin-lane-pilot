# @lane-pilot/council

A council is a bounded meeting of model seats, each with a role and ideally its own provider and
model, that works one product or business question to a decision. The package holds the
protocol; the host plugin supplies the seats (threads), the evidence and the storage.

```text
question ─► chair sets the agenda ─► round 1: every seat's position
         ─► moderator: continue? ─► round n: replies to the others (skeptic last)
         ─► chair writes the decision record ─► Markdown page + next tasks
```

## Contract

| Export | What it does |
|---|---|
| `DEFAULT_ROLES`, `resolveRoles(names)` | Product, demand, audience, skeptic (plus growth and ux on request), each with its instruction |
| `agendaPrompt`, `seatPrompt`, `chairPrompt` | The three prompts; seats receive the evidence pack and only the feed since their last turn |
| `parseAgenda`, `parseDecisionRecord` | Strict JSON parsing of the chair's answers, fenced or not |
| `moderatorDecision`, `roundNovelty` | Continue while a round still adds new terms and rounds remain; otherwise synthesize. A `Moderator` (Jev) may override |
| `runCouncil(session, io)` | The whole protocol over an `io` of `spawnTurn`, `evidence`, `save`, `moderator`, `isStopped` |
| `councilMigrations`, `createCouncilSession`, `addCouncilMessage`, `listCouncilMessages`, `setCouncilState`, `getCouncilSession`, `listCouncilSessions` | SQLite storage of sessions, seats and the feed |
| `decisionMarkdown` | The decision page for `docs/decisions/` |

## Who may use it

Lane Pilot's council stage; any plugin that can spawn model threads and wants several models to
argue a question to a documented decision instead of answering it once.
