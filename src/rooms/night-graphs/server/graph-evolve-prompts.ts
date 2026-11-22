import { redactKnown } from "@lane-pilot/kit";
import { WORKFLOW_REFERENCE } from "@lane-pilot/workflow-engine";
import { BROAD_DYNAMIC_CATEGORIES } from "../category-taxonomy";
import type { ProcessBlueprint } from "../process-blueprint";
import type { CompanionSkillCandidate } from "./companion-skill-merge";
import type { EvolveCatalogContext, EvolveCollectInput, EvolveReviewVerdict } from "./graph-evolve-pipeline";
import type { GraphEvolveCandidate } from "./graph-evolve-suite";

const LEAN_PATTERNS_GUIDE = [
  "Lean Flexibility & Anti-Bloat Patterns (must pass validateWorkflow, validateLeanSuitePolicy, and runDraftTest):",
  "1) scope_tier input: EVERY phase_graph and master_orchestrator MUST declare optional input `scope_tier: { type: \"string\", default: \"standard\", description: \"Execution depth: express | standard | full\" }`, and subworkflow nodes MUST forward `scope_tier: \"{{$inputs.scope_tier}}\"` in `subworkflow.inputs`.",
  "2) Bypassable human gates: `options: [\"approve\", \"skip\", \"rework\", \"abort\"]`, `out: { answer: \"string\", answer_kind: \"approve|skip|rework|abort\" }`, forward edge `when: \"<id>.answer_kind == 'approve' || <id>.answer_kind == 'skip'\"` (max 2 human gates per phase_graph).",
  "3) Linear optional stages (skip_when + skip_out, NEVER bypass edges): keep optional stages (`legacy_import`, `ingest_api`, `imagery`/`brand_imagery`, or any stage reading optional inputs) on the linear path with `skip_when` + `skip_out` — NEVER route a bypass edge around a producer whose `{{node.field}}` outputs are read downstream! CRITICAL `valueSpecOf` rule for `skip_out` and `emit.map`: `\"\"`, numbers, booleans, paths with `/`, and single bare tokens (`\"accepted\"`, `\"approve\"`, `\"skipped\"`) are valid literals, whereas multi-word strings MUST be wrapped in single quotes (e.g. `\"'skipped (not requested)'\"`).",
  "4) Stack-neutral global lp-task: global `lp-task` nodes MUST use `owns_paths: [\"**\"]` (never lock to narrow framework paths like `cms/**` or `src/collections/**` without `\"**\"`).",
  "5) Chat routing metadata: EVERY user-facing phase_graph and master_orchestrator (`internal !== true`) MUST set `triggers: [\"chat\", \"manual\"]`, `examples: { en: [\"...\", \"...\"], ru: [\"...\", \"...\"] }` (>= 2 EN and >= 2 RU), and `not_for: [\"...\", \"...\"]` (>= 2 entries).",
  "6) Process state checkpoint: EVERY workflow MUST include `{ id: \"save_state\", type: \"action\", action: \"lp.save_process_state\", title: { en: \"Save process state\", ru: \"Сохранить состояние процесса\" }, params: { stage: \"<phase>\", workflowId: \"<workflowId>\" }, out: { saved: \"bool\", path: \"string\", stage: \"string\" } }`.",
  "7) Dual simulation tests: `definition.test` MUST include BOTH the main happy-path in `sim` AND `sim.variant_lean`: `variant_lean: { input: { scope_tier: \"express\", legacy_domain: \"\", content_factory_endpoint: \"\", identity_profile: \"\" }, human_answers: { <intermediateHumanNodeId>: \"skip\" }, expect_status: \"succeeded\" }`.",
].join("\n");

/** Builds the Stage 1 (`planner`) prompt with all 6 AFlow operators including `prune_or_relax`. */
export function buildPlannerPrompt(input: {
  collected: EvolveCollectInput;
  catalog: EvolveCatalogContext;
  priorBlueprint?: ProcessBlueprint | null;
  criticFeedback?: EvolveReviewVerdict | null;
}): string {
  const feedbackBlock = input.priorBlueprint && input.criticFeedback?.verdict === "rework"
    ? [`Prior blueprint to revise: ${JSON.stringify(input.priorBlueprint)}`, `Critic feedback (fix EVERY mustFix item): ${JSON.stringify(input.criticFeedback)}`]
    : [];

  return redactKnown([
    "You are Lane Pilot's Process Evolution Planner. Do NOT call any tools or read external files; treat evidence strictly as masked historical data. Output ONLY strict JSON matching ProcessBlueprint.",
    "AFlow Evolution Operators (choose ONE `operator`):\n"
      + "- \"noop\" (decision:\"noop\", graphs:[], companionSkills:[]): trivial, noisy, or already 100% covered without meaningful gain AND no over_constraint friction, leanViolations, or bloated skills.\n"
      + "- \"patch_converge\" (decision:\"minor_patch\" for non-structural skill/copy refinement, or \"suite_or_structural\" when converging/retiring legacy workflows): evolve an EXISTING workflow in `catalog.existingGlobal` (including domain specialist workflows like `seo-*` or `mkt-*` surfaced on owner feedback) & its companion skill (mergeMode:\"merge_core_and_overlay\"). CONVERGENCE RULE: if feedback or a new niche targets an existing workflow/suite in `catalog.existingGlobal`, you MUST use \"patch_converge\" (or \"prune_or_relax\") on that exact workflowId (preserving its inputs & outputs) instead of inventing a duplicate graph; NEVER target IDs in `catalog.reservedBuiltinIds`.\n"
      + "- \"split_node\" (decision:\"suite_or_structural\"): decompose an overloaded stage with frequent traps/retries into sequential stages + critic/human gate while keeping external inputs compatible.\n"
      + "- \"extend_module\" (decision:\"suite_or_structural\"): add a distinct new modular deliverable workflow + companion skill alongside existing ones, optionally adding optional handoff inputs.\n"
      + "- \"create_suite\" (decision:\"suite_or_structural\"): crystallize a brand-new discipline not yet covered in existingGlobal (2..5 phase_graphs + 1 master_orchestrator) with companionSkills (mergeMode:\"create_bundle\").\n"
      + "- \"prune_or_relax\" (decision:\"suite_or_structural\" or \"minor_patch\"): CHOOSE THIS whenever evidence contains `over_constraint` deltas / `frictionSignals` (`overConstraintCount > 0`), OR `catalog.existingGlobal` reports non-empty `leanViolations`, OR `catalog.existingCompanionSkills` has `sectionCount > 14` or `hasSemanticDuplicates: true`. It refines EXISTING global workflows & companion skills to be leaner and more flexible (marking rigid/niche stages `necessity:\"optional\"` with `skipConditionHint`, making `human` gates skippable, relaxing narrow `owns_paths`, compacting duplicate skill sections) while keeping external workflow IDs, `inputs`, and `outputs` backwards-compatible.",
    "Lean Spine, Complexity Ceiling & Companion Skill Hygiene:\n"
      + `- category.id MUST be a broad craft discipline ONLY (${Object.keys(BROAD_DYNAMIC_CATEGORIES).join(", ")}, or builtin categories like seo, code, research, business). NEVER encode client niches/verticals in category.id, workflowId, or name! Parameterize niches via project_archetype / domain_brief inputs and companionSkills[].archetypeOverlays.\n`
      + "- Mark EVERY stage in `graphs[].stages[]` with `necessity: \"core\" | \"optional\"` and add `skipConditionHint` on optional/niche stages (`legacy_import`, `ingest_api`, `imagery` / `brand_imagery`). Set `standaloneChat: true` on user-facing phase_graphs.\n"
      + "- Complexity ceiling: each `phase_graph` MUST have `<= 7` executable stages (excluding `lp.save_process_state` / `emit`) and `<= 2` `human` gates.\n"
      + "- Paired `companionSkills`: reuse exact `goldenSectionTitles` from `catalog.existingCompanionSkills` instead of inventing paraphrased duplicates, mark conditional sections with `[optional: when <condition>]`, and stay within `<= 14` golden sections and `<= 16` core rules.\n"
      + "- Preserve real tools (metamcp -> mcp:[\"metamcp\"], image-studio -> plugins:[\"image-studio\"]), multi-variant parameters (variants_count + owner human selection), and strict step-order invariants. 100% de-projectize all IDs, labels, and rules.",
    `Catalog context: ${JSON.stringify(input.catalog)}`,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
    ...feedbackBlock,
    'Return ONLY JSON: {"operator":"noop"|"patch_converge"|"split_node"|"extend_module"|"create_suite"|"prune_or_relax","decision":"noop"|"minor_patch"|"suite_or_structural","rationale":"...","category":{"id":"...","label":{"en":"...","ru":"..."}}|null,"supersededWorkflowIds":[],"orderInvariants":["..."],"variantParameters":[{"name":"...","rangeOrValues":"...","purpose":"..."}],"requiredIntegrations":{"mcp":[],"plugins":[],"skills":[]},"graphs":[{"workflowId":"...","kind":"phase_graph"|"master_orchestrator","standaloneChat":true,"name":{"en":"...","ru":"..."},"description":{"en":"...","ru":"..."},"dependsOnGraphs":[],"inputs":{},"outputs":{},"stages":[{"id":"...","nodeType":"agent|human|lp-task|action|subworkflow|parallel","role":"...","subworkflowId":"...","purpose":"...","necessity":"core"|"optional","skipConditionHint":"...","skills":[],"mcp":[],"plugins":[],"contractRules":[]}],"acceptanceCriteria":["..."]}],"companionSkills":[{"skillId":"...","workflowIds":[],"mergeMode":"create_bundle"|"merge_core_and_overlay","summary":"...","whenToUse":"...","whenNotToUse":"...","coreRules":[],"goldenSkeletonSections":[],"qaRubricChecks":[],"archetypeOverlays":[{"slug":"...","title":"...","whenToUse":"...","rules":[]}]}]}',
  ].join("\n\n"));
}

/** Builds the Stage 2 (`plan-critic`) prompt including Gate 9 anti-bloat & flexibility checks. */
export function buildPlanCriticPrompt(input: {
  blueprint: ProcessBlueprint;
  collected: EvolveCollectInput;
  catalog: EvolveCatalogContext;
}): string {
  return redactKnown([
    "You are Lane Pilot's Cross-Family Process Plan Critic. Do NOT call any tools or read external files. Output ONLY strict JSON: {\"verdict\":\"pass\"|\"rework\",\"findings\":[...],\"mustFix\":[...]}.",
    input.blueprint.decision === "noop"
      ? "The planner chose decision:\"noop\" despite rich trajectory clusters or lean/over-constraint signals. Check whether valuable recurring workflows, `over_constraint` friction, `leanViolations`, or bloated companion skills were mistakenly ignored; if so return verdict:\"rework\" requiring \"prune_or_relax\" or the proper operator."
      : "Audit the blueprint against the masked evidence on ALL 9 hard gates:\n"
        + "1) Tool & MCP fidelity: observed MCPs/plugins preserved on the right stages.\n"
        + "2) Multi-variant fidelity: multi-concept/palette trajectories parameterize variants_count + owner human selection.\n"
        + "3) Order invariants: causal ordering respected (CTA/conversion map before design; UI Kit before full page templates; QA gate after build).\n"
        + "4) Modular suite layout: multi-phase work split cleanly into 2..5 phase_graphs + master_orchestrator (no cycles, no collision with reservedBuiltinIds).\n"
        + "5) 100% De-projectization: zero domain/brand/person names, proj_*, host_*, /Users/... or /home/... leaks; dynamic category has bilingual {en, ru} label.\n"
        + "6) Actionable deliverables: clear inputs, outputs, and acceptanceCriteria per graph.\n"
        + "7) Anti-clone & Category Taxonomy Ceiling: reject niche categories/workflowIds (use broad discipline + archetypeOverlays + project_archetype input), and reject create_suite when an existing global suite covers the same deliverable discipline (require patch_converge or extend_module).\n"
        + "8) Companion Skill Golden Skeleton: when structured deliverables or artifactSkeletons appear, require companionSkills with Golden Skeleton sections, QA rubric checks, and archetypeOverlays, reusing existing `goldenSectionTitles` without paraphrased duplicates.\n"
        + "9) Anti-Bloat, Flexibility & Core-vs-Optional Spine: reject any `phase_graph` with > 7 executable stages or > 2 `human` gates; require `necessity: \"optional\"` + `skipConditionHint` on niche stages (`legacy_import`, `ingest_api`, `imagery` / `brand_imagery`); require `standaloneChat: true` on user-facing phase_graphs; require `operator: \"prune_or_relax\"` (preserving external workflow IDs/inputs/outputs) whenever `over_constraint` deltas, `frictionSignals`, non-empty `existingGlobal[].leanViolations`, or bloated/duplicated `existingCompanionSkills` exist.",
    `Catalog context: ${JSON.stringify(input.catalog)}`,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
    `Candidate blueprint: ${JSON.stringify(input.blueprint)}`,
  ].join("\n\n"));
}

/** Builds the Stage 3 (`workflow-architect`) prompt with lean workflow-engine patterns. */
export function buildArchitectPrompt(input: {
  blueprint: ProcessBlueprint;
  collected: EvolveCollectInput;
  catalog: EvolveCatalogContext;
  priorCandidates?: readonly GraphEvolveCandidate[];
  validationErrors?: readonly string[];
  auditFeedback?: EvolveReviewVerdict | null;
}): string {
  const repairBlock = [
    ...(input.priorCandidates?.length ? [`Prior candidates to repair: ${JSON.stringify(input.priorCandidates)}`] : []),
    ...(input.validationErrors?.length ? [`Schema/validation/test errors to fix: ${JSON.stringify(input.validationErrors)}`] : []),
    ...(input.auditFeedback?.verdict === "rework" ? [`Auditor feedback to fix: ${JSON.stringify(input.auditFeedback)}`] : []),
  ];

  return redactKnown([
    'CRITICAL: You are running as a batch JSON workflow compiler in an isolated room. Do NOT call any tools, do NOT read files, and do NOT invoke lane_pilot_* or skill tools. Output ONLY the single JSON object {"candidates":[...],"companionSkills":[...]} in your message.',
    `WORKFLOW_REFERENCE:\n${JSON.stringify(WORKFLOW_REFERENCE)}`,
    "Strict Compiler Rules (must pass loadWorkflow, validateWorkflow, validateLeanSuitePolicy, and runDraftTest):\n"
      + "1) Compile EVERY graph in blueprint.graphs into one GraphEvolveCandidate ({workflowId, scope:\"global\", name:{en,ru}, description:{en,ru}, category, sourceDeltaIds, definition}). When evolving an existing workflow in `catalog.existingGlobal` (including domain built-in overlays like `seo-*` or `mkt-*`), preserve its exact workflowId, keep ALL existing `inputs` and `outputs` backwards-compatible (new inputs MUST be optional with defaults), and bump `version`.\n"
      + "2) In definition set: id, version (1 or existingGlobal.version + 1), name, description, category:{id,label:{en,ru}}, status:\"draft\", triggers:[\"chat\",\"manual\"] (for user-facing workflows, with >=2 EN & >=2 RU `examples` and >=2 `not_for` entries), inputs ({type:\"string\"|\"int\"|\"number\"|\"bool\"|\"json\", required?, default?, description?}), outputs ({<field>:\"string\"|\"int\"|\"bool\"}), nodes, edges, test.\n"
      + "3) nodeSchema is .strict() — NEVER invent extra node properties!\n"
      + "   - agent: {id, type:\"agent\", title:{en,ru}, role:\"planner\"|\"analyst\"|\"plan-critic\"|\"auditor\"|\"browser-qa\"|\"errand\"|\"specialist:design-lead\"|\"specialist:copy-lead\"|\"specialist:seo-specialist\"|\"specialist:growth-marketer\"|\"specialist:visual-artist\"|\"specialist:tavily\", prompt, skills?, plugins?, mcp?, skip_when?, skip_out?, out:{...}, guards?:{maxVisits?:3}}. NEVER set model, provider, reasoning, model_preset, or environment!\n"
      + "   - human: {id, type:\"human\", title:{en,ru}, question, options:[\"approve\",\"skip\",\"rework\",\"abort\"], out:{answer:\"string\", answer_kind:\"approve|skip|rework|abort\"}}.\n"
      + "   - lp-task: {id, type:\"lp-task\", title:{en,ru}, owns_paths:[\"**\"], contract:{title, goal, acceptance:[...]}, skip_when?, skip_out?, out:{state:\"accepted|blocked|failed\", summary:\"string\"}, guards?:{maxVisits?:2}}.\n"
      + "   - subworkflow: {id, type:\"subworkflow\", title:{en,ru}, workflow:\"<child-workflow-id>\", inputs:{\"scope_tier\":\"{{$inputs.scope_tier}}\", \"<childInput>\":\"{{$inputs.goal}}\"}, skip_when?, skip_out?, out:{\"<childOutputField>\":\"<matchingChildOutputType>\"}, guards:{maxVisits:1}}.\n"
      + "   - checkpoint action: {id:\"save_state\", type:\"action\", action:\"lp.save_process_state\", title:{en:\"Save process state\", ru:\"Сохранить состояние процесса\"}, params:{stage:\"<phase>\", workflowId:\"<workflowId>\"}, out:{saved:\"bool\", path:\"string\", stage:\"string\"}}.\n"
      + "   - terminal action: {id:\"done\", type:\"action\", action:\"emit\", map:{...every workflow output...}}.\n"
      + "4) Every loop back-edge MUST have guards:{maxVisits:N} on the loop target AND when:\"... && visits('target') < N\" plus a fallback edge.\n"
      + "5) test: {id:\"happy-path\", sim:{input:{...}, stubs:{<nodeId>:{...}}, human_answers:{<humanNodeId>:\"approve\"}, expect_status:\"succeeded\", expect_path:[...], variant_lean:{input:{scope_tier:\"express\", legacy_domain:\"\", content_factory_endpoint:\"\", identity_profile:\"\"}, human_answers:{<intermediateHumanNodeId>:\"skip\"}, expect_status:\"succeeded\"}}}.\n"
      + "6) Companion Skills: For every spec in blueprint.companionSkills, attach <skillId> to `skills` of the relevant craft `agent` nodes on spec.workflowIds, and either omit companionSkills (so the compiler renders SKILL.md + references/* deterministically) or return companionSkills:[{skillId, workflowIds, mergeMode, files?:[{path,text}]}].",
    LEAN_PATTERNS_GUIDE,
    `Catalog context: ${JSON.stringify(input.catalog)}`,
    `Delta IDs: ${JSON.stringify(input.collected.deltaIds)}`,
    `Approved blueprint: ${JSON.stringify(input.blueprint)}`,
    ...repairBlock,
  ].join("\n\n"));
}

/** Builds the Stage 4 (`auditor`) prompt calibrated for lean flexibility invariants and strict schema rules. */
export function buildAuditorPrompt(input: {
  blueprint: ProcessBlueprint;
  candidates: readonly GraphEvolveCandidate[];
  companionSkills?: readonly CompanionSkillCandidate[];
  collected: EvolveCollectInput;
}): string {
  const companionSummary = input.companionSkills?.length
    ? [`Companion skills: ${JSON.stringify(input.companionSkills.map((s) => ({
        skillId: s.skillId, workflowIds: s.workflowIds, mergeMode: s.mergeMode,
        files: s.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.text, "utf8"), preview: f.text.slice(0, 600) })),
      })))}`]
    : [];

  return redactKnown([
    "You are Lane Pilot's Cross-Family Senior Suite Auditor. Do NOT call any tools or read external files. Output ONLY strict JSON: {\"verdict\":\"pass\"|\"rework\",\"findings\":[\"<string>\",...],\"mustFix\":[\"<string>\",...]} (elements of findings and mustFix MUST be plain strings).",
    `WORKFLOW_REFERENCE:\n${JSON.stringify(WORKFLOW_REFERENCE)}`,
    "Engine Schema Constraints (NEVER ask mustFix to violate WORKFLOW_REFERENCE):\n"
      + "- nodeSchema is .strict(): ONLY type:\"agent\" nodes accept mcp, plugins, and skills. type:\"human\", \"lp-task\", \"subworkflow\", and \"action\" nodes FORBID mcp/plugins/skills.\n"
      + "- There is NO parallel node type without child/join in the schema; definition.test is a SINGLE {id, sim} object per workflow (with optional `sim.variant_*` subcases).\n"
      + "Audit Calibration (return verdict:\"rework\" + non-empty mustFix ONLY for genuine schema-valid blocking defects):\n"
      + "- Blocking (rework): planned graph missing; master_orchestrator subworkflow links missing or out of order; required MCPs/plugins/variants_count/human gates missing; lean flexibility violations (missing `scope_tier` input/forwarding, `human` gates missing `\"skip\"`, optional stages missing `skip_when`+`skip_out` or bypassed producer outputs, invalid unquoted multi-word `skip_out` literals, global `lp-task` with narrow framework `owns_paths` lacking `\"**\"`, missing `triggers:[\"chat\",\"manual\"]` with >=2 EN/RU `examples` & >=2 `not_for`, missing `lp.save_process_state`, missing `test.sim.variant_lean`, or >7 executable nodes / >2 human gates per phase_graph); companion skill Golden Skeleton/QA rubric/archetype overlays missing, uncompacted (>14 sections), or unattached to craft agent nodes when blueprint.companionSkills is non-empty; or project/domain/brand/person/proj_*/host_* leaks.\n"
      + "- Non-blocking (pass): return verdict:\"pass\" with mustFix:[] when all structural, lean-flexibility, skill-attachment, and de-projectization invariants hold.",
    `Approved blueprint: ${JSON.stringify(input.blueprint)}`,
    `Compiled candidates: ${JSON.stringify(input.candidates)}`,
    ...companionSummary,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
  ].join("\n\n"));
}
