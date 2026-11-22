// Owns: src/rooms/errands/trajectory-delta.ts, src/rooms/night-graphs/friction-signals.ts, src/rooms/night-graphs/lean-suite-policy.ts, src/rooms/night-graphs/process-blueprint.ts, src/rooms/night-graphs/deprojectize.ts, src/rooms/night-graphs/server/graph-evolve-prompts.ts, src/rooms/night-graphs/server/companion-skill-evolve.ts, src/rooms/storage/pilot-day-digest-store.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { forgetSecrets } from "@lane-pilot/kit";
import { casWriteSkillBundle, createDraftStore, loadWorkflow, type SkillBundleFile } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listUnprocessedTrajectoryDeltas, recordTrajectoryDelta } from "../../src/rooms/errands";
import {
  MAX_GOLDEN_SKELETON_SECTIONS,
  lintAndVerifyCompanionSkill,
  readExistingCompanionSkills,
  renderCompanionSkillBundle,
  validateLeanSuitePolicy,
  verifyNonDestructiveSkillMerge,
  type CompanionSkillSpec,
  type ProcessBlueprint,
} from "../../src/rooms/night-graphs";
import { collectGraphEvolveEvidence, digestPilotDayDialogues } from "../../src/rooms/night-graphs/server";
import { listPilotDayCandidates } from "../../src/rooms/storage";
import { createRun, createTask, openDatabase, setRunObjective, setRunThread } from "../../src/rooms/plugin-db";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function makeTempSkillsRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-lean-reg-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  forgetSecrets();
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Semantic Companion Skill Compaction & Non-Destructive Guard", () => {
  const twentyTwoSections = [
    "Existing source audit (kept / dropped)",
    "Research dossier: trends, foreign references, domestic competitors, foreign competitors, visual audit",
    "Positioning and offer architecture",
    "Competitor teardown matrix",
    "Site tree, homepage archetype and conversion paths",
    "Presentation variants with archetype-contract check",
    "Design tokens and color system",
    "Font pair comparison",
    "UI kit components and states",
    "Copy and microcopy matrix",
    "Page templates and design specs",
    "Export and QA log",
    "Brand visual language and tone",
    "Source audit",
    "Trend and reference report",
    "Site tree and conversion paths",
    "Homepage role",
    "Presentation variants",
    "Page assembly (1440/390)",
    "Export and spec",
    "Design tokens specification",
    "Live QA report",
  ];

  const existing22Files: SkillBundleFile[] = [
    {
      path: "SKILL.md",
      text: [
        "---",
        "name: site-craft-standard",
        'description: "Universal craft standard for site design and assembly. Use when building websites, UI kits, or design specifications. Do not use for backend APIs."',
        "---",
        "",
        "# site-craft-standard",
        "",
        "## Core Rules",
        "",
        "- Complete positioning and conversion paths before visual polish.",
        "- Verify design tokens and UI kit states before page assembly.",
        "",
        "## References",
        "",
        "- [Golden Skeleton](references/golden-skeleton.md)",
        "- [QA Rubric](references/qa-rubric.md)",
        "- [Archetype: personal-brand](references/archetype-personal-brand.md)",
        "- [Archetype: legacy-rebuild](references/archetype-legacy-rebuild.md)",
        "- [Archetype: tools-catalog](references/archetype-tools-catalog.md)",
        "",
      ].join("\n"),
    },
    {
      path: "references/golden-skeleton.md",
      text: [
        "# Golden Skeleton: site-craft-standard",
        "",
        ...twentyTwoSections.map((title, i) => `## ${i + 1}. ${title}\n\nProvide structured, verifiable deliverable details for ${title}.`),
        "",
      ].join("\n"),
    },
    {
      path: "references/qa-rubric.md",
      text: [
        "# QA Rubric: site-craft-standard",
        "",
        "- [ ] Contrast ratio satisfies accessibility thresholds across light and dark surfaces",
        "- [ ] Page assembly passes responsive checks at 1440px and 390px viewports",
        "- [ ] Every conversion CTA maps to a concrete user path in the site tree",
        "",
      ].join("\n"),
    },
    {
      path: "references/archetype-personal-brand.md",
      text: "# Archetype Overlay: Personal Brand\n\nWhen to apply: expert or founder personal-brand sites.\n\n## Archetype Rules\n\n- Lead the first screen with authority proof and concise positioning.\n",
    },
    {
      path: "references/archetype-legacy-rebuild.md",
      text: "# Archetype Overlay: Legacy Rebuild\n\nWhen to apply: redesigning an existing legacy website.\n\n## Archetype Rules\n\n- Keep or redirect every high-intent legacy URL before publishing.\n",
    },
    {
      path: "references/archetype-tools-catalog.md",
      text: "# Archetype Overlay: Tools Catalog\n\nWhen to apply: multi-tool or catalog directories.\n\n## Archetype Rules\n\n- Provide consistent filterable catalog cards and task entry points.\n",
    },
  ];

  it("compacts 22-section site-craft-standard into <= 14 sections without losing unique topics, preserves [optional: when ...], avoids '..', and blocks unique section removal", async () => {
    const skillsRoot = makeTempSkillsRoot();
    const writeRes = await casWriteSkillBundle(skillsRoot, "site-craft-standard", existing22Files, null);
    expect(writeRes.status).toBe("applied");

    const { existingCompanionSkills } = await readExistingCompanionSkills(skillsRoot);
    const info = existingCompanionSkills.find((s) => s.skillId === "site-craft-standard");
    expect(info).toBeDefined();
    expect(info?.sectionCount).toBe(22);
    expect(info?.hasSemanticDuplicates).toBe(true);
    expect(info?.archetypes.sort()).toEqual(["legacy-rebuild", "personal-brand", "tools-catalog"]);

    const logs: string[] = [];
    const spec: CompanionSkillSpec = {
      skillId: "site-craft-standard",
      workflowIds: ["site-discovery", "site-design"],
      mergeMode: "merge_core_and_overlay",
      summary: "Universal craft standard for site design, copy, and UI kit assembly.",
      whenToUse: "Use when designing or auditing multi-page sites, prototypes, or UI kits.",
      whenNotToUse: "Do not use for backend APIs or pure database schema migrations.",
      coreRules: [
        "Complete positioning and conversion paths before visual polish.",
        "Preserve optional sections only when matching feature inputs are provided.",
      ],
      goldenSkeletonSections: [
        "Existing source audit (kept / dropped) [optional: when $inputs.legacy_domain != '']",
        "Research dossier: trends, foreign references, domestic competitors, foreign competitors, visual audit",
        "Export and QA log",
      ],
      qaRubricChecks: [
        "Contrast ratio satisfies accessibility thresholds across light and dark surfaces",
      ],
      archetypeOverlays: [
        {
          slug: "personal-brand",
          title: "Personal Brand",
          whenToUse: "expert or founder personal-brand sites",
          rules: ["Pair authority bio with concrete proof metrics."],
        },
      ],
    };

    const candidate = renderCompanionSkillBundle(spec, existing22Files, { log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes("DEBUG [nightGraphs.skillMerge] semantic_compacted"))).toBe(true);

    const skeletonFile = candidate.files.find((f) => f.path === "references/golden-skeleton.md")!;
    const skeletonHeadings = [...skeletonFile.text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!);
    expect(skeletonHeadings.length).toBeLessThanOrEqual(MAX_GOLDEN_SKELETON_SECTIONS);
    expect(skeletonFile.text).toContain("[optional: when $inputs.legacy_domain != '']");

    const skillMd = candidate.files.find((f) => f.path === "SKILL.md")!;
    const descMatch = /^description:\s*(.+)$/m.exec(skillMd.text);
    expect(descMatch).not.toBeNull();
    expect(JSON.parse(descMatch![1]!)).not.toContain("..");

    const lintVerdict = lintAndVerifyCompanionSkill(candidate, existing22Files, { log: (m) => logs.push(m) });
    expect(lintVerdict.ok).toBe(true);
    expect(lintVerdict.findings).toEqual([]);

    // Tampering with golden-skeleton.md by deleting genuinely unique sections must be blocked
    const tamperedSkeleton = skeletonFile.text
      .split(/\n(?=##\s+)/)
      .filter((block) => !/Competitor teardown matrix|Font pair comparison/i.test(block))
      .join("\n");
    const tamperedFiles = candidate.files.map((f) =>
      f.path === "references/golden-skeleton.md" ? { path: f.path, text: tamperedSkeleton } : f,
    );
    const tamperedFindings = verifyNonDestructiveSkillMerge(existing22Files, tamperedFiles);
    expect(tamperedFindings.some((f) => f.code === "missing_golden_section")).toBe(true);
    expect(tamperedFindings.some((f) => f.detail.includes("Competitor teardown matrix"))).toBe(true);
    expect(tamperedFindings.some((f) => f.detail.includes("Font pair comparison"))).toBe(true);
  });
});

describe("Lean Suite Policy Deterministic Validator (validateLeanSuitePolicy)", () => {
  type WorkflowCandidate = { workflowId: string; scope?: "global" | "project"; definition: Record<string, unknown> };

  function makeValidLeanSuite(): WorkflowCandidate[] {
    return [
      {
        workflowId: "site-discovery",
        scope: "global",
        definition: {
          id: "site-discovery",
          inputs: {
            goal: { type: "string", required: true },
            legacy_domain: { type: "string?", default: "" },
            scope_tier: { type: "string", values: ["express", "standard", "full"], default: "standard" },
          },
          triggers: ["chat", "manual"],
          examples: {
            en: ["Design a multi-page site with research and UI kit", "Plan and build a conversion-focused site"],
            ru: ["Спроектировать сайт с ресёрчем и UI-китом", "Собрать многостраничный сайт под ключ"],
          },
          not_for: ["Pure backend API changes", "Database migration scripts"],
          nodes: [
            {
              id: "legacy_import",
              type: "agent",
              skip_when: "$inputs.legacy_domain == ''",
              prompt: "Inspect $inputs.legacy_domain",
              out: { summary: "string", kept_urls: "string" },
              skip_out: { summary: "'skipped'", kept_urls: "'none'" },
            },
            {
              id: "imagery",
              type: "agent",
              skip_when: "$inputs.scope_tier == 'express'",
              prompt: "Prepare imagery with {{legacy_import.summary}}",
              out: { photo_sets: "string" },
              skip_out: { photo_sets: "'none'" },
            },
            {
              id: "review_gate",
              type: "human",
              question: "Approve discovery direction?",
              options: ["approve", "rework", "skip", "abort"],
              out: { answer_kind: "approve|rework|skip|abort" },
            },
            {
              id: "pages",
              type: "lp-task",
              owns_paths: ["**"],
              prompt: "Assemble pages using {{imagery.photo_sets}}",
              out: { done: "bool" },
            },
            {
              id: "save_state",
              type: "action",
              action: "lp.save_process_state",
              out: { saved: "bool", path: "string", stage: "string" },
            },
          ],
          edges: [
            { from: "$start", to: "legacy_import" },
            { from: "legacy_import", to: "imagery" },
            { from: "imagery", to: "review_gate" },
            { from: "review_gate", to: "pages", when: "review_gate.answer_kind != 'abort'" },
            { from: "pages", to: "save_state" },
            { from: "save_state", to: "$end" },
          ],
          test: {
            sim: {
              variant_lean: {
                input: { goal: "Build lean landing", scope_tier: "express" },
                human_answers: { review_gate: "skip" },
                expect_status: "succeeded",
              },
            },
          },
        },
      },
      {
        workflowId: "site-suite",
        scope: "global",
        definition: {
          id: "site-suite",
          inputs: {
            goal: { type: "string", required: true },
            scope_tier: { type: "string", values: ["express", "standard", "full"], default: "standard" },
          },
          triggers: ["chat", "manual"],
          examples: {
            en: ["Run full end-to-end website suite", "Orchestrate site discovery through assembly"],
            ru: ["Запустить полный пайплайн создания сайта", "Провести сайт от ресёрча до сборки"],
          },
          not_for: ["Single-file bug fixes", "Cron monitoring jobs"],
          nodes: [
            {
              id: "phase_discovery",
              type: "subworkflow",
              workflow: "site-discovery",
              inputs: { goal: "{{$inputs.goal}}", scope_tier: "{{$inputs.scope_tier}}" },
            },
            {
              id: "save_suite_state",
              type: "action",
              action: "lp.save_process_state",
              out: { saved: "bool", path: "string", stage: "string" },
            },
          ],
          edges: [
            { from: "$start", to: "phase_discovery" },
            { from: "phase_discovery", to: "save_suite_state" },
            { from: "save_suite_state", to: "$end" },
          ],
          test: {
            sim: {
              variant_lean: {
                input: { goal: "Build lean landing", scope_tier: "express" },
                human_answers: {},
                expect_status: "succeeded",
              },
            },
          },
        },
      },
    ];
  }

  const validBlueprint: ProcessBlueprint = {
    operator: "create_suite",
    decision: "suite_or_structural",
    rationale: "Lean 2-graph site suite",
    category: { id: "websites", label: { en: "Websites", ru: "Сайты" } },
    orderInvariants: ["discovery before pages"],
    variantParameters: [{ name: "scope_tier", rangeOrValues: "express|standard|full", purpose: "depth" }],
    requiredIntegrations: { mcp: [], plugins: [], skills: ["site-craft-standard"] },
    graphs: [
      {
        workflowId: "site-discovery",
        kind: "phase_graph",
        name: { en: "Site Discovery", ru: "Разведка сайта" },
        description: { en: "Discovery phase", ru: "Фаза разведки" },
        dependsOnGraphs: [],
        inputs: {},
        outputs: {},
        stages: [],
        acceptanceCriteria: [],
      },
      {
        workflowId: "site-suite",
        kind: "master_orchestrator",
        name: { en: "Site Suite", ru: "Сьют сайта" },
        description: { en: "Master suite", ru: "Мастер-сьют" },
        dependsOnGraphs: ["site-discovery"],
        inputs: {},
        outputs: {},
        stages: [],
        acceptanceCriteria: [],
      },
    ],
  };

  it("passes a valid lean 2-graph suite and emits DEBUG checked log", () => {
    const logs: string[] = [];
    const verdict = validateLeanSuitePolicy(makeValidLeanSuite(), {
      blueprint: validBlueprint,
      log: (m) => logs.push(m),
      logLevel: "debug",
    });
    expect(verdict).toEqual({ ok: true, violations: [] });
    expect(logs.some((l) => l.includes("DEBUG [nightGraphs.leanPolicy] checked"))).toBe(true);
  });

  it("detects every individual lean policy violation and emits WARN violation logs", () => {
    const mutatePhase = (mutator: (def: Record<string, any>) => void) => {
      const suite = makeValidLeanSuite();
      mutator(suite[0]!.definition);
      const logs: string[] = [];
      const verdict = validateLeanSuitePolicy(suite, { blueprint: validBlueprint, log: (m) => logs.push(m) });
      return { verdict, logs };
    };

    // 1. narrow_framework_owns_paths
    {
      const { verdict, logs } = mutatePhase((def) => {
        const pages = def.nodes.find((n: any) => n.id === "pages");
        pages.owns_paths = ["cms/**", "src/collections/**"];
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.some((v) => v.code === "narrow_framework_owns_paths")).toBe(true);
      expect(logs.some((l) => l.includes("WARN [nightGraphs.leanPolicy] violation"))).toBe(true);
    }

    // 2. optional_stage_not_skippable
    {
      const { verdict } = mutatePhase((def) => {
        const legacy = def.nodes.find((n: any) => n.id === "legacy_import");
        delete legacy.skip_when;
      });
      expect(verdict.violations.some((v) => v.code === "optional_stage_not_skippable")).toBe(true);
    }

    // 3. invalid_skip_out_literal
    {
      const { verdict } = mutatePhase((def) => {
        const legacy = def.nodes.find((n: any) => n.id === "legacy_import");
        legacy.skip_out = { summary: "unquoted multi word string", kept_urls: "'none'" };
      });
      expect(verdict.violations.some((v) => v.code === "invalid_skip_out_literal")).toBe(true);
    }

    // 4. bypassed_producer_without_skip_out (imagery_router -> pages bypassing imagery)
    {
      const { verdict } = mutatePhase((def) => {
        def.nodes.unshift({
          id: "imagery_router",
          type: "agent",
          prompt: "Route imagery mode",
          out: { route: "string" },
        });
        def.edges = [
          { from: "$start", to: "legacy_import" },
          { from: "legacy_import", to: "imagery_router" },
          { from: "imagery_router", to: "imagery", when: "$inputs.scope_tier != 'express'" },
          { from: "imagery_router", to: "pages", when: "$inputs.scope_tier == 'express'" },
          { from: "imagery", to: "review_gate" },
          { from: "review_gate", to: "pages", when: "review_gate.answer_kind != 'abort'" },
          { from: "pages", to: "save_state" },
          { from: "save_state", to: "$end" },
        ];
      });
      expect(verdict.violations.some((v) => v.code === "bypassed_producer_without_skip_out")).toBe(true);
    }

    // 5. human_gate_not_skippable
    {
      const { verdict } = mutatePhase((def) => {
        const gate = def.nodes.find((n: any) => n.id === "review_gate");
        gate.options = ["approve", "rework", "abort"];
      });
      expect(verdict.violations.some((v) => v.code === "human_gate_not_skippable")).toBe(true);
    }

    // 6. node_budget_exceeded & human_gate_budget_exceeded
    {
      const { verdict } = mutatePhase((def) => {
        def.nodes = [
          ...def.nodes,
          { id: "extra_1", type: "agent", prompt: "Step 1", out: { ok: "bool" } },
          { id: "extra_2", type: "agent", prompt: "Step 2", out: { ok: "bool" } },
          { id: "extra_gate_2", type: "human", question: "Gate 2?", options: ["approve", "skip"], out: { answer_kind: "approve|skip" } },
          { id: "extra_gate_3", type: "human", question: "Gate 3?", options: ["approve", "skip"], out: { answer_kind: "approve|skip" } },
        ];
      });
      expect(verdict.violations.some((v) => v.code === "node_budget_exceeded")).toBe(true);
      expect(verdict.violations.some((v) => v.code === "human_gate_budget_exceeded")).toBe(true);
    }

    // 7. missing_scope_tier
    {
      const { verdict } = mutatePhase((def) => {
        delete def.inputs.scope_tier;
      });
      expect(verdict.violations.some((v) => v.code === "missing_scope_tier")).toBe(true);
    }

    // 8. missing_variant_lean_test
    {
      const { verdict } = mutatePhase((def) => {
        delete def.test.sim.variant_lean;
      });
      expect(verdict.violations.some((v) => v.code === "missing_variant_lean_test")).toBe(true);
    }

    // 9. missing_chat_routing_metadata
    {
      const { verdict } = mutatePhase((def) => {
        def.triggers = ["manual"];
        def.examples = { en: ["Only one"], ru: ["Только один"] };
      });
      expect(verdict.violations.some((v) => v.code === "missing_chat_routing_metadata")).toBe(true);
    }

    // 10. missing_or_invalid_process_state_checkpoint
    {
      const { verdict } = mutatePhase((def) => {
        def.nodes = def.nodes.filter((n: any) => n.action !== "lp.save_process_state");
      });
      expect(verdict.violations.some((v) => v.code === "missing_or_invalid_process_state_checkpoint")).toBe(true);
    }
  });
});

describe("over_constraint SQLite Rebuild Migration & digestPilotDayDialogues Friction Extraction", () => {
  it("persists over_constraint deltas, keeps the append-only DELETE trigger intact, and extracts friction signals during daily digest", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    cleanups.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);

    // 1. Verify over_constraint kind works and append-only DELETE trigger remains enforced
    const directRes = recordTrajectoryDelta(db as never, {
      id: "tdelta_direct_oc_1",
      projectId: "proj-direct",
      threadId: "thr-direct",
      workflowId: "site-suite",
      stageArchetype: "design",
      interventionKind: "over_constraint",
      rawSummary: "User requested skipping CMS schema step",
      now: 1_700_000_000_000,
    });
    expect(directRes.status).toBe("recorded");
    expect(directRes.row?.interventionKind).toBe("over_constraint");

    const persisted = db.prepare("SELECT intervention_kind FROM lane_pilot_trajectory_delta WHERE id = ?").get("tdelta_direct_oc_1") as
      | { intervention_kind: string }
      | undefined;
    expect(persisted?.intervention_kind).toBe("over_constraint");

    expect(() => db.prepare("DELETE FROM lane_pilot_trajectory_delta WHERE id = ?").run("tdelta_direct_oc_1")).toThrow(
      /trajectory deltas are append-only/,
    );

    // 2. Seed workflow_run (with skip & abort human gate steps) + pilot_run (with owns-paths rejection & user simplification remark)
    const t0 = Date.UTC(2026, 10, 21, 0, 0, 0);
    const sinceMs = t0;
    const untilMs = t0 + 86_400_000;

    db.prepare(
      `INSERT INTO lane_pilot_wf_run
        (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, reason, inputs_json, output_json, created_at, updated_at)
       VALUES (?, ?, 1, 'sha', '{}', ?, ?, ?, ?, '{}', ?, ?)`,
    ).run(
      "wf_run_friction_1",
      "site-design",
      "proj_lean_1",
      "failed",
      "owner aborted cms gate",
      JSON.stringify({ threadId: "thr_wf_friction" }),
      t0 + 1_000,
      t0 + 10_000,
    );

    const insertStep = db.prepare(
      `INSERT INTO lane_pilot_wf_step
        (run_id, step_key, origin, node_id, visit, scope, state, attempt, input_json, output_json, error, updated_at)
       VALUES (?, ?, ?, ?, 1, '', 'succeeded', 1, '{}', ?, NULL, ?)`,
    );
    insertStep.run(
      "wf_run_friction_1",
      "brief_gate#1",
      "brief_gate#1",
      "brief_gate",
      JSON.stringify({ answer_kind: "skip", answer: "skip" }),
      t0 + 5_000,
    );
    insertStep.run(
      "wf_run_friction_1",
      "cms_gate#1",
      "cms_gate#1",
      "cms_gate",
      JSON.stringify({ answer_kind: "abort", answer: "abort" }),
      t0 + 6_000,
    );

    createRun(db, "pilot_run_friction_1", "proj_lean_1", "cli");
    setRunThread(db, "pilot_run_friction_1", "thr_pm_friction");
    setRunObjective(db, "pilot_run_friction_1", "Build lightweight marketing site");
    createTask(db, { id: "task_friction_1", runId: "pilot_run_friction_1", kind: "cli", contract: { title: "Assemble static pages" } });
    db.prepare(
      `INSERT INTO lane_pilot_gate_event
        (project_id, run_id, task_id, gate, status, input_sha256, output_sha256, attempt, occurred_at)
       VALUES (?, ?, ?, 'owns-paths', 'rejected', ?, NULL, 1, ?)`,
    ).run("proj_lean_1", "pilot_run_friction_1", "task_friction_1", "a".repeat(64), t0 + 11_000);
    db.prepare("UPDATE lane_pilot_run SET state = 'blocked', updated_at = ? WHERE id = ?").run(t0 + 12_000, "pilot_run_friction_1");

    const logs: string[] = [];
    const runModel = vi.fn(async (): Promise<string> =>
      JSON.stringify({
        process_key: "websites|site-creation",
        category_hint: { id: "websites", label: { en: "Websites", ru: "Сайты" } },
        outcome: "failed",
        goal: "Build a lightweight site without forced CMS scaffolding",
        traps: ["Forced CMS gate and narrow owns-paths blocked progress"],
        lessons: ["Allow skipping optional gates and keep owns-paths broad"],
        interventions: [],
      }),
    );

    const summary = await digestPilotDayDialogues({
      db,
      now: () => t0 + 20_000,
      sinceMs,
      untilMs,
      projectNames: async () => new Map([["proj_lean_1", "Client Site"]]),
      readOutline: async (threadId) => {
        if (threadId === "thr_pm_friction") {
          return "User: это лишнее, сделай проще без CMS\nAssistant: Понял, собираю статический вариант";
        }
        if (threadId === "thr_wf_friction") {
          return "User: пропусти этот шаг\nAssistant: Перехожу дальше";
        }
        return null;
      },
      runModel,
      log: (m) => logs.push(m),
    });

    expect(summary.digested).toBe(2);
    expect(summary.deltasRecorded).toBeGreaterThanOrEqual(4);

    const allDeltas = listUnprocessedTrajectoryDeltas(db as never, { projectId: "proj_lean_1" });
    const overConstraints = allDeltas.filter((d) => d.interventionKind === "over_constraint");
    expect(overConstraints.length).toBeGreaterThanOrEqual(4);

    const summaries = overConstraints.map((d) => d.maskedSummary);
    expect(summaries.some((s) => s.includes("brief_gate") && s.includes("skip"))).toBe(true);
    expect(summaries.some((s) => s.includes("cms_gate") && s.includes("abort"))).toBe(true);
    expect(summaries.some((s) => s.includes("owns-paths"))).toBe(true);
    expect(summaries.some((s) => s.includes("это лишнее, сделай проще без CMS"))).toBe(true);

    expect(logs.some((l) => l.includes("INFO [nightGraphs.pilotDayDigest] friction_recorded"))).toBe(true);
  });

  it("ignores hand-authored owner global workflows (e.g. batch-then-test) in leanDebt and does not re-read unchanged pilot_chat threads across days", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    cleanups.push(async () => {
      db.close();
    });

    const drafts = createDraftStore(db as never);
    const manualDef = {
      id: "batch-then-test",
      version: 2,
      name: { en: "Batch then test", ru: "Пакет затем тест" },
      description: { en: "Owner custom Matvey-style batch workflow", ru: "Ручной граф владельца" },
      status: "published",
      triggers: ["manual"],
      inputs: { batch: { type: "string", required: true } },
      outputs: { status: "string" },
      nodes: [
        { id: "gate", type: "human", title: { en: "Confirm", ru: "Подтвердить" }, question: "Proceed?", options: ["approve", "abort"], out: { answer_kind: "approve|abort" } },
        { id: "done", type: "action", action: "emit", map: { status: "'ok'" } },
      ],
      edges: [
        { from: "start", to: "gate" },
        { from: "gate", to: "done" },
      ],
    };
    drafts.create({
      projectId: "proj_owner",
      threadId: "thr_architect_manual",
      scope: "global",
      name: manualDef.name,
      description: manualDef.description,
      workflowId: "batch-then-test",
      definition: manualDef,
    });
    const loadedManual = loadWorkflow(manualDef);
    expect(loadedManual.ok).toBe(true);
    if (!loadedManual.ok) return;

    const collected = collectGraphEvolveEvidence(db as never, {
      existingGlobalWorkflows: [{ workflow: loadedManual.workflow }],
    });
    expect(collected.leanDebtCount).toBe(0);
    expect(collected.status).toBe("empty");

    // Verify unchanged pilot_chat is NOT re-selected on a subsequent day even with lookback_days = 14
    const day1 = Date.parse("2026-11-20T12:00:00Z");
    const day2 = Date.parse("2026-11-21T12:00:00Z");
    db.prepare("INSERT INTO lane_pilot_activation (pm_thread_id, project_id, run_id, claimed_at) VALUES (?, ?, ?, ?)").run(
      "thr_idle_chat",
      "proj_owner",
      "run_unused",
      day1,
    );

    const firstPass = await digestPilotDayDialogues({
      db,
      now: () => day1 + 60_000,
      sinceMs: day1 - 86_400_000,
      untilMs: day1 + 30_000,
      projectNames: async () => new Map([["proj_owner", "Owner Project"]]),
      readOutline: async () => "User: quick question\nAssistant: answered",
      runModel: async () =>
        JSON.stringify({
          process_key: "code|routine",
          outcome: "done",
          goal: "Routine coding question",
          traps: [],
          lessons: [],
          interventions: [],
        }),
    });
    expect(firstPass.digested).toBe(1);

    // Next day with wide 14-day window and NO new activity: must return 0 candidates
    const nextDayCandidates = listPilotDayCandidates(db, day2 - 14 * 86_400_000, day2, 20, { projectId: "proj_owner" });
    expect(nextDayCandidates).toHaveLength(0);
  });
});
