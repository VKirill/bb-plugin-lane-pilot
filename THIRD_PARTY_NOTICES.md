# Third-party notices

## catlog22/maestro-flow, MIT

Some prompt texts, thresholds and checklists of Lane Pilot's reviewing and diagnosing roles are adapted from
[catlog22/maestro-flow](https://github.com/catlog22/maestro-flow) (MIT). They are rewritten for Lane Pilot's roles and
tools; no Maestro code, command or agent runtime is included.

Adapted from `workflows/plan.md`, `workflows/grill.md`, `workflows/verify.md`, `workflows/review.md`,
`workflows/debug.md`, `workflows/auto-test.md`, `workflows/swarm/wf-review.js`, `ref/scientific-debug.md` and
`ref/frontend-verify.md`:

| Idea | Source | Lane Pilot file |
|---|---|---|
| `read_first` and checkable convergence criteria without subjective words, one feature per task, a question without file:line is not a question | plan.md, grill.md | `src/stages/role-method.ts` (`PLAN_CRITIC_METHOD`), used by `src/stages/critique.ts` |
| Three acceptance layers (exists, substantive, wired), anti-patterns, six review dimensions, BLOCK / WARN / PASS thresholds, majority of 2 of 3 for critical and high findings | verify.md, review.md, wf-review.js | `src/stages/role-method.ts` (`CODE_CRITIC_METHOD`), used by `src/stages/code-critique.ts` |
| Scientific debugging: confirmed root cause, at most 3 hypotheses with evidence, backward tracing, three-strike check | debug.md, ref/scientific-debug.md | `src/stages/role-method.ts` (`SCIENTIFIC_DEBUG_METHOD`), used by `src/server/self-repair.ts` |
| Failure classification `test_defect` / `code_defect` / `env_issue` | auto-test.md | `src/stages/role-method.ts` (`FAILURE_TRIAGE_METHOD`), used by `src/server/self-repair.ts` |
| Deterministic three-layer browser acceptance (entry point, write request, DOM result); silence is never a pass | ref/frontend-verify.md | `src/stages/role-method.ts` (`FRONTEND_VERIFY_METHOD`), used by `src/server/stages/qa-thread.ts` |

The upstream repository states the MIT license in `package.json` and its README but ships no `LICENSE` file, so the
copyright line below names the repository's owner as given there.

```
MIT License

Copyright (c) catlog22

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
