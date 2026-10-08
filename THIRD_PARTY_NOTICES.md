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
| `read_first` and checkable convergence criteria without subjective words, one feature per task, a question without file:line is not a question | plan.md, grill.md | `src/rooms/critique/role-method.ts` (`PLAN_CRITIC_METHOD`), used by `src/rooms/critique/critique.ts` |
| Three acceptance layers (exists, substantive, wired), anti-patterns, six review dimensions, BLOCK / WARN / PASS thresholds, majority of 2 of 3 for critical and high findings | verify.md, review.md, wf-review.js | `src/rooms/critique/role-method.ts` (`CODE_CRITIC_METHOD`), used by `src/rooms/critique/code-critique.ts` |
| Scientific debugging: confirmed root cause, at most 3 hypotheses with evidence, backward tracing, three-strike check | debug.md, ref/scientific-debug.md | `src/rooms/critique/role-method.ts` (`SCIENTIFIC_DEBUG_METHOD`), used by `src/rooms/self-repair/server/self-repair.ts` |
| Failure classification `test_defect` / `code_defect` / `env_issue` | auto-test.md | `src/rooms/critique/role-method.ts` (`FAILURE_TRIAGE_METHOD`), used by `src/rooms/self-repair/server/self-repair.ts` |
| Deterministic three-layer browser acceptance (entry point, write request, DOM result); silence is never a pass | ref/frontend-verify.md | `src/rooms/critique/role-method.ts` (`FRONTEND_VERIFY_METHOD`), used by `src/rooms/qa/server/qa-thread.ts` |

The workflow chains of `workflows/*.json` (W3) take their stage texts, thresholds and the composition of the chains from more
files of the same repository. The texts are rewritten for Lane Pilot's roles (`src/rooms/critique/role-method.ts`: `ANALYST_METHOD`,
`PLANNER_METHOD`, `AUDITOR_METHOD`) and each node of a chain names its source in its `src` field; no Maestro code is copied.

| Idea | Source file of maestro-flow | Where in Lane Pilot |
|---|---|---|
| The chain map, the selection priorities, `detectNextAction` (state-based «continue») | `workflows/maestro.md` | `workflows/analyze-plan-execute.json` and the chain family, `src/workflow/router.ts` |
| Analysis with locked / free / deferred decisions, confidence, pressure pass | `workflows/analyze.md` | `workflows/lp.analyze.json`, `ANALYST_METHOD` |
| Roadmap sessions, the complete-cycle rule, progressive and direct layers | `workflows/roadmap.md`, `workflows/roadmap-common.md` | `workflows/roadmap-driven.json` |
| Multi-role brainstorm with a cross-role reviewer | `workflows/brainstorm.md` | `workflows/lp.brainstorm.json`, `workflows/brainstorm-driven.json` |
| Formal specification package and readiness score | `workflows/blueprint.md` | `workflows/blueprint-driven.json` |
| Retrospective lenses and knowledge candidates | `workflows/retrospective.md`, `ref/knowledge-closeout.md` | `workflows/retrospective.json`, `workflows/lp.close.json`, `workflows/milestone-close.json` |
| Issue discovery perspectives, gap analysis of issues, severity inference | `workflows/issue-discover.md`, `ref/issue-gaps-analyze.md`, `ref/severity-inference.md` | `workflows/issue-discover.json`, `workflows/issue-full.json`, `workflows/issue-quick.json` |
| Finishing a piece of work | `ref/finish-work.md` | `workflows/lp.close.json` |
| Two-of-three review confirmation | `workflows/swarm/wf-review.js` | `workflows/lp.review.json` (the `votes` of `confirm`) |
| Review, security, defensive, UI, improvement, plan-execute and debug campaigns (their dimensions and hard rules only, not the campaigns) | `workflows/odyssey-security.md`, `odyssey-review.md`, `odyssey-defensive.md`, `odyssey-ui.md`, `odyssey-improve.md`, `odyssey-planex.md`, `odyssey-debug.md` | `workflows/lp.review.json`, `security-audit.json`, `refactor.json`, `debug.json`, `ui-audit.json` |
| A small task without a plan (self-check, then one quick task) | `.claude/commands/maestro-companion.md` | `workflows/companion.json` |
| Closing a session and its knowledge | `.claude/commands/maestro-session-manage.md` | `workflows/milestone-close.json` |
| Goal audit, confidence, re-grounding, the two-round ceiling of a fix loop, then the owner | `.claude/commands/maestro-ralph.md`, `prepare/ralph.md` | `workflows/lp.close.json`, `AUDITOR_METHOD`, the loop limits of the chains |
| `convergence.criteria` (checkable, no subjective words) and `files[]` with the concrete change | `templates/task.json`, `prepare/plan.md` | `taskV2Schema` (`src/contracts.ts`), `src/rooms/tasks/server/contract-lint.ts` |
| The step contract (`consumes` / `produces` / `gates`) and the typed artifact kinds (`plan`, `findings`, `verdict`, ...) | the `contract:` heads of `prepare/*.md` | `src/workflow/artifacts.ts`, `src/workflow/contract.ts`, the `consumes` / `produces` / `gates` of `workflows/*.json` |
| Verification in three layers (exists, substantive, wired) with the unified gap object | `templates/verification.json`, `prepare/verify.md` | the `verification/1` kind in `src/workflow/artifacts.ts` |

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

## Impeccable, Apache License 2.0

The chains `impeccable-build` and `ui-audit` use ideas of [Impeccable](https://github.com/pbakaus/impeccable) by Paul Bakaus
(Apache License 2.0), through the copy that Maestro-Flow vendors (Impeccable 4.1.3, upstream commit
`4c5243fcd42d39c1fc281adcaf10be0913095f74`, `workflows/impeccable/` of maestro-flow): the direction contract before any
work, «verification is limited to what was seen», a fresh finish reviewer who did not build the page, the critique score out of 40 and the
audit score out of 20, and the shape of `DESIGN.md`. The texts are changed: they are rewritten for Lane Pilot's roles and
tools and shortened into node prompts of `workflows/impeccable-build.json` and `workflows/ui-audit.json`. No Impeccable code or
script is included. The license notice and the license text are kept below, as the license asks. The copy in maestro-flow
carries no separate NOTICE of Impeccable itself; its `NOTICE.md` lists the detector's bundled parser libraries and a
platform-design reference (MIT, ehmo), none of which Lane Pilot uses.

Copyright 2025 Paul Bakaus. Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at
<http://www.apache.org/licenses/LICENSE-2.0>.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to the Licensor for inclusion in the Work by the copyright
      owner or by an individual or Legal Entity authorized to submit on
      behalf of the copyright owner. For the purposes of this definition,
      "submitted" means any form of electronic, verbal, or written
      communication sent to the Licensor or its representatives, including
      but not limited to communication on electronic mailing lists, source
      code control systems, and issue tracking systems that are managed by,
      or on behalf of, the Licensor for the purpose of discussing and
      improving the Work, but excluding communication that is conspicuously
      marked or otherwise designated in writing by the copyright owner as
      "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2025 Paul Bakaus

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
