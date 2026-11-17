---
id: your-fact-id
schema_version: 2
status: active
memory_type: normative
truth_mode: decision
claim: One sentence that will fire again next month
language: en
source:
  authority: owner
evidence:
  - type: conversation
    ref: YYYY-MM-DD
risk: low
sensitivity: internal
context_priority: always
retrieval:
  areas: [procedures]
  hint: synonyms, including russian
verification:
  command: test -f .agents/PROGRESS.md
---

This is a review template for one proposed hub claim, not a local memory
record or a CLI input file. Keep it outside `.agents/memory/`, then publish
the final factual claim through the documented BB door.

Why this rule exists. Related: [[other-id]].

Publish one concise factual claim with:

```bash
bb lane-pilot memory write "<fact>" --project <project-id>
```

Do not create `.agents/memory/` or `.cls/` corpus, confirmation, index or
fallback files. For a lesson, use `lane_pilot_memory` with `action: "lesson"`
inside a Lane Pilot PM chat; this template does not define a terminal lesson
command.
