
## `deliverable.validate`

Three-layer acceptance of a non-code artifact inside a chain (DOM probe → Jev screenshot → vision-agent review).

**In (params or inputs/with):**
- `validator` — `page` | `design` | `text` | `3d` | `video` | `invoice` | `composite` | `artifact` (default `artifact`)
- `target` — path or URL the validator checks
- `brief` — object: `objective`/`prompt`/`topic`, `design: true` to force the vision layer, validator extras (`inn`, `amount`, `poly_budget`, `concept_path`, `render_path`, `axes`)
- `hostId` — machine holding the artifact (page/design/3d/video/invoice need it)

**Out:** `{ verdict: "pass" | "rework", reason: string, issues?: object }` — `verdict` is `pass` only when all layers accept; otherwise `rework` and `reason`/`issues` carry the evidence (DOM selectors, Jev box, reviewer findings).
