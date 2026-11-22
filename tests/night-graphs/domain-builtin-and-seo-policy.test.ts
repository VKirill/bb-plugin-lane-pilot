// Owns: packages/workflow-engine/src/draft-store.ts, src/rooms/native-agent/server/specialist-session-policy.ts, src/rooms/night-graphs/domain-builtin-overlay.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDraftStore,
  loadWorkflowStore,
  readSkillBundle,
} from "@lane-pilot/workflow-engine";
import { nativeThreadKey, roleProfilePolicy } from "../../src/rooms/contracts";
import { recordTrajectoryDelta } from "../../src/rooms/errands";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  STANDALONE_SPECIALIST_SKILL_PACKS,
  createNativeSpecialistSessionPolicy,
  specialistProfileAccess,
} from "../../src/rooms/native-agent/server";
import { EMPLOYEES, MAIN_AGENT_PROFILE_IDS } from "../../src/rooms/contracts/server";
import { compileMainAgentProfile } from "../../src/rooms/native-agent";
import {
  applyGraphEvolveCandidates,
  collectGraphEvolveEvidence,
  renderCompanionSkillBundle,
  validateEvolveSuiteCandidates,
} from "../../src/rooms/night-graphs";
import { rollbackPanelWorkflowDraft } from "../../src/rooms/pilot-panel/server/workflow-drafts";
import {
  BUILTIN_SOURCES,
  builtinWorkflow,
  isCoreLockedBuiltinId,
  isEvolvableDomainBuiltinId,
  rawBuiltinWorkflowSource,
} from "../../src/rooms/workflow";

const tempDirs: string[] = [];
const openDbs: Array<ReturnType<typeof openDatabase>> = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeDb() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length) {
    try { openDbs.pop()?.close(); } catch { /* ignore */ }
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("domain built-in overlay evolution & seo-specialist bounded skill policy", () => {
  it("locks core Matvey orchestration/coding built-ins while marking specialist domain craft built-ins evolvable", async () => {
    for (const lockedId of [
      "lp-task-pipeline",
      "lp.plan",
      "lp.build",
      "lp.review",
      "lp.graph-evolve-nightly",
      "lp.specialist-eval",
      "analyze-plan-execute",
      "full-lifecycle",
      "specialist",
      "sp-specialist-tick",
      "code-review",
      "ship",
    ]) {
      expect(isCoreLockedBuiltinId(lockedId), lockedId).toBe(true);
      expect(isEvolvableDomainBuiltinId(lockedId), lockedId).toBe(false);
    }

    for (const domainId of ["seo-brief", "seo-cocoon", "seo-page", "mkt-landing-cro-audit", "mkt-direct-search-campaign", "social-post", "web-research", "reels"]) {
      expect(isEvolvableDomainBuiltinId(domainId), domainId).toBe(true);
      expect(isCoreLockedBuiltinId(domainId), domainId).toBe(false);
    }

    const db = makeDb();
    const globalDir = makeTempDir("lp-core-locked-wf-");
    const lockedAttempt = await validateEvolveSuiteCandidates({ db, globalDir: () => globalDir }, [{
      workflowId: "analyze-plan-execute",
      scope: "global",
      name: { en: "Tampered Core", ru: "Изменённое ядро" },
      description: { en: "Should fail", ru: "Должно отклониться" },
      definition: rawBuiltinWorkflowSource("analyze-plan-execute")!,
    }]);
    expect(lockedAttempt.ok).toBe(false);
    expect(lockedAttempt.errors.some((e) => e.includes("analyze-plan-execute: id_reserved"))).toBe(true);
  });

  it("never flags factory domain built-ins or hand-crafted ~/.bb/skills as leanDebt when no feedback deltas exist", () => {
    const db = makeDb();
    const summary = collectGraphEvolveEvidence(db, {
      existingGlobalWorkflows: [],
      existingCompanionSkills: [
        {
          skillId: "seo-page-templates",
          archetypes: [],
          sectionCount: 0,
          goldenSectionTitles: [],
          coreRuleCount: 0,
          hasSemanticDuplicates: false,
        },
      ],
    });
    expect(summary.leanDebtCount).toBe(0);
    expect(summary.status).toBe("empty");
    expect(summary.clusters).toHaveLength(0);
  });

  it("evolves seo-brief + hand-crafted seo-page-templates skill on owner feedback and cleanly rolls back to factory v1", async () => {
    const db = makeDb();
    const globalDir = makeTempDir("lp-seo-overlay-wf-");
    const skillsRoot = makeTempDir("lp-seo-overlay-skills-");

    // Seed a realistic pre-existing hand-crafted SEO skill with custom reference files and a Python script.
    const seoSkillDir = join(skillsRoot, "seo-page-templates");
    mkdirSync(join(seoSkillDir, "references"), { recursive: true });
    mkdirSync(join(seoSkillDir, "scripts"), { recursive: true });
    const origSkillMd = [
      "---",
      "name: seo-page-templates",
      'description: "Canonical SEO page structures and intent-aligned brief templates for commercial, service, and informational pages."',
      "---",
      "",
      "# SEO Page Templates",
      "",
      "Read `references/04-brief-draft-and-qc-gates.md` and `references/service.md` before drafting briefs.",
      "",
    ].join("\n");
    const origRefGates = "# Brief Draft & QC Gates\n\nKeep primary SERP intent explicit.\n";
    const origRefService = "# Service Page Template\n\nInclude commercial proof and pricing table.\n";
    const origScript = "#!/usr/bin/env python3\nprint('ok')\n";
    writeFileSync(join(seoSkillDir, "SKILL.md"), origSkillMd, "utf8");
    writeFileSync(join(seoSkillDir, "references", "04-brief-draft-and-qc-gates.md"), origRefGates, "utf8");
    writeFileSync(join(seoSkillDir, "references", "service.md"), origRefService, "utf8");
    writeFileSync(join(seoSkillDir, "scripts", "check_template.py"), origScript, "utf8");

    // 1. Owner gives feedback during an seo-brief run -> trajectory_delta recorded.
    const delta = recordTrajectoryDelta(db, {
      projectId: "proj_test_seo",
      threadId: "thr_seo_feedback_1",
      workflowId: "seo-brief",
      stageArchetype: "brief_synthesis",
      interventionKind: "rule_added",
      resolvedSkills: ["seo-page-templates"],
      rawSummary: "Require explicit commercial vs informational SERP intent split and entity coverage table in every SEO brief",
    });
    const collected = collectGraphEvolveEvidence(db);
    expect(collected.status).toBe("ready");
    expect(collected.clusters.some((c) => c.processKey === "seo-brief|domain-feedback")).toBe(true);

    // 2. Rejects overlay that breaks factory outputs contract.
    const factoryRaw = rawBuiltinWorkflowSource("seo-brief")!;
    const brokenOutputsDef = {
      ...factoryRaw,
      outputs: { brief_path: "string" }, // drops other factory outputs of seo-brief
    };
    const brokenCheck = await validateEvolveSuiteCandidates({ db, globalDir: () => globalDir, skillsDir: () => skillsRoot }, [{
      workflowId: "seo-brief",
      scope: "global",
      name: factoryRaw.name as { en: string; ru: string },
      description: factoryRaw.description as { en: string; ru: string },
      definition: brokenOutputsDef,
    }]);
    expect(brokenCheck.ok).toBe(false);
    expect(brokenCheck.errors.some((e) => e.includes("overlay_contract:missing_factory_output:"))).toBe(true);

    // 3. Valid minor-patch overlay on seo-brief + non-destructive merge on hand-crafted seo-page-templates.
    const existingBundle = await readSkillBundle(skillsRoot, "seo-page-templates");
    const mergedSkill = renderCompanionSkillBundle({
      skillId: "seo-page-templates",
      workflowIds: ["seo-brief"],
      mergeMode: "merge_core_and_overlay",
      summary: "Canonical SEO page structures and intent-aligned brief templates",
      whenToUse: "preparing SEO content briefs and page structures",
      whenNotToUse: "writing runtime backend application code",
      coreRules: [
        "Separate commercial vs informational SERP intent before outlining headings.",
        "Include an explicit entity coverage table mapped to H2/H3 sections.",
      ],
      goldenSkeletonSections: ["SERP Intent Classification", "Entity Coverage Matrix", "Heading Outline"],
      qaRubricChecks: ["Primary SERP intent is classified with zero mixed-intent cannibalization."],
      archetypeOverlays: [{
        slug: "b2b-service",
        title: "B2B Service Landing",
        whenToUse: "commercial B2B service briefs",
        rules: ["Require case-study proof block and SLA comparison table."],
      }],
    }, existingBundle.files);

    const refinedNodes = (JSON.parse(JSON.stringify(factoryRaw.nodes)) as Array<Record<string, unknown>>).map((n) =>
      n.type === "agent" && typeof n.prompt === "string"
        ? { ...n, prompt: `${n.prompt}\n\nEnsure SERP intent classification and entity coverage matrix follow seo-page-templates.` }
        : n,
    );
    const refinedDef = { ...factoryRaw, nodes: refinedNodes };

    const applied = await applyGraphEvolveCandidates(
      { db, globalDir: () => globalDir, skillsDir: () => skillsRoot },
      [{
        workflowId: "seo-brief",
        scope: "global",
        name: factoryRaw.name as { en: string; ru: string },
        description: factoryRaw.description as { en: string; ru: string },
        definition: refinedDef,
        sourceDeltaIds: [delta.row!.id],
      }],
      { companionSkills: [mergedSkill], operator: "patch_converge", auditVerdict: "pass" },
    );

    expect(applied.publishedCount).toBe(1);
    expect(applied.outcomes[0]).toMatchObject({
      workflowId: "seo-brief",
      kind: "minor_patch",
      status: "auto_published",
      version: 2,
    });
    expect(existsSync(join(globalDir, "seo-brief.json"))).toBe(true);

    // Store resolves global v2 overlay over factory v1 builtin.
    const storeAfterEvolve = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir });
    const activeSeoBrief = storeAfterEvolve.resolve("seo-brief");
    expect(activeSeoBrief?.version).toBe(2);
    expect(storeAfterEvolve.list().find((s) => s.workflow.id === "seo-brief")?.origin).toBe("global");

    // Pre-existing hand-crafted skill kept its original body, references, AND scripts!
    const updatedSkillMd = readFileSync(join(seoSkillDir, "SKILL.md"), "utf8");
    expect(updatedSkillMd).toContain("# SEO Page Templates");
    expect(updatedSkillMd).toContain("references/04-brief-draft-and-qc-gates.md");
    expect(updatedSkillMd).toContain("Separate commercial vs informational SERP intent");
    expect(readFileSync(join(seoSkillDir, "references", "04-brief-draft-and-qc-gates.md"), "utf8")).toBe(origRefGates);
    expect(readFileSync(join(seoSkillDir, "references", "service.md"), "utf8")).toBe(origRefService);
    expect(existsSync(join(seoSkillDir, "references", "golden-skeleton.md"))).toBe(true);
    expect(existsSync(join(seoSkillDir, "references", "archetype-b2b-service.md"))).toBe(true);
    expect(readFileSync(join(seoSkillDir, "scripts", "check_template.py"), "utf8")).toBe(origScript);

    // 4. 1-Click Rollback removes global overlay file (falling back to factory builtin v1) and restores original skill files!
    const draftId = applied.outcomes[0]!.draftId!;
    expect(createDraftStore(db).previousVersionSnapshot(draftId)?.version).toBe(1);

    const fakeCtx = {
      db,
      bb: { sdk: {} },
      log: () => undefined,
      realtime: { notify: () => undefined },
    } as never;
    const rb = await rollbackPanelWorkflowDraft(fakeCtx, { globalDir: () => globalDir, skillsDir: () => skillsRoot }, { draftId });
    expect(rb.ok).toBe(true);
    expect(existsSync(join(globalDir, "seo-brief.json"))).toBe(false);

    const storeAfterRollback = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir });
    const restoredSeoBrief = storeAfterRollback.resolve("seo-brief");
    expect(restoredSeoBrief?.version).toBe(builtinWorkflow("seo-brief")!.version);
    expect(storeAfterRollback.list().find((s) => s.workflow.id === "seo-brief")?.origin).toBe("builtin");

    // Hand-crafted skill restored byte-for-byte; generated skeleton/overlay cleaned up; Python script untouched.
    expect(readFileSync(join(seoSkillDir, "SKILL.md"), "utf8")).toBe(origSkillMd);
    expect(readFileSync(join(seoSkillDir, "references", "04-brief-draft-and-qc-gates.md"), "utf8")).toBe(origRefGates);
    expect(readFileSync(join(seoSkillDir, "references", "service.md"), "utf8")).toBe(origRefService);
    expect(existsSync(join(seoSkillDir, "references", "golden-skeleton.md"))).toBe(false);
    expect(existsSync(join(seoSkillDir, "references", "archetype-b2b-service.md"))).toBe(false);
    expect(readFileSync(join(seoSkillDir, "scripts", "check_template.py"), "utf8")).toBe(origScript);
  });

  it("narrows seo-specialist skills in both workflow steps and standalone Composer chats instead of loading 200-300+ global skills", async () => {
    // 1. Workflow step policy (`specialist:seo-specialist` + step-specific skills)
    const stepPolicy = roleProfilePolicy("specialist:seo-specialist", {}, {
      skills: ["topical-graph-architect", "seo-evidence-contract", "seo-tools"],
    });
    expect(stepPolicy.skills).toEqual({
      mode: "allow",
      names: [
        "env-catalog",
        "seo-drmax-orchestrator",
        "topical-graph-architect",
        "seo-evidence-contract",
        "seo-tools",
      ],
    });

    // 2. Standalone Composer chat policy (`createNativeSpecialistSessionPolicy`)
    const db = makeDb();
    const kvMap = new Map<string, unknown>();
    kvMap.set(nativeThreadKey("thr_composer_seo"), {
      token: "563d23a8-da01-4680-a796-aab89bbde995",
      projectId: "proj_seo_1",
      agentId: "seo-specialist",
      profileMode: "session-override",
      agentsJson: null,
      sourceHash: null,
      sourceVersion: "bb-session-1",
      createdAt: 1795000000000,
    });
    kvMap.set(nativeThreadKey("thr_composer_pm"), {
      token: "ff4130cb-d4ef-4cae-b998-43918234c3ae",
      projectId: "proj_seo_1",
      agentId: "dev-orchestrator",
      profileMode: "session-override",
      agentsJson: null,
      sourceHash: null,
      sourceVersion: "bb-session-1",
      createdAt: 1795000000000,
    });
    kvMap.set(nativeThreadKey("thr_workflow_seo_child"), {
      token: "1a06d19d-348e-4f25-a6ca-9351f63ee73c",
      projectId: "proj_seo_1",
      agentId: "seo-specialist",
      profileMode: "session-override",
      agentsJson: null,
      sourceHash: null,
      sourceVersion: "bb-session-1",
      createdAt: 1795000000000,
      parentRunId: "lprun_parent_1",
    });

    const resolver = createNativeSpecialistSessionPolicy({
      db,
      bb: {
        storage: {
          kv: {
            get: async <T>(key: string) => kvMap.get(key) as T | undefined,
          },
        },
      } as never,
      ownedAgents: async () => ({}),
    });

    const seoComposerPolicy = await resolver({
      thread: { id: "thr_composer_seo" },
      project: { id: "proj_seo_1" },
      pluginMetadata: { role: "pm" },
    });
    expect(seoComposerPolicy?.skills?.mode).toBe("allow");
    const allowedNames = seoComposerPolicy?.skills?.names ?? [];
    expect(allowedNames.length).toBeLessThanOrEqual(20);
    expect(allowedNames).toContain("seo-drmax-orchestrator");
    expect(allowedNames).toContain("seo-page-templates");
    expect(allowedNames).toContain("env-catalog");
    expect(allowedNames).toContain("agent-tools");
    expect(allowedNames).toEqual(expect.arrayContaining([...STANDALONE_SPECIALIST_SKILL_PACKS["seo-specialist"]!]));
    expect(allowedNames).not.toContain("blender-director");
    expect(allowedNames).not.toContain("roblox-toolkit");

    // Coordinator PM chat and workflow child helper threads return null (untouched).
    expect(await resolver({ thread: { id: "thr_composer_pm" }, project: { id: "proj_seo_1" }, pluginMetadata: { role: "pm" } })).toBeNull();
    expect(await resolver({ thread: { id: "thr_workflow_seo_child" }, project: { id: "proj_seo_1" }, pluginMetadata: { role: "specialist", lanePilotWorkflowRunId: "wfrun_1" } })).toBeNull();
  });

  it("enforces zero skill leaks and domain self-sufficiency across all 12 bundled specialists, sub-roles, workflow-architect, lead, and custom agents", async () => {
    const db = makeDb();
    const kvMap = new Map<string, unknown>();
    const bindThread = (threadId: string, agentId: string) => {
      kvMap.set(nativeThreadKey(threadId), {
        token: "563d23a8-da01-4680-a796-aab89bbde995",
        projectId: "proj_all_specs",
        agentId,
        profileMode: "session-override",
        agentsJson: null,
        sourceHash: null,
        sourceVersion: "bb-session-1",
        createdAt: 1795000000000,
      });
    };

    for (const id of MAIN_AGENT_PROFILE_IDS) bindThread(`thr_${id}`, id);
    bindThread("thr_custom_plain", "brand-editor");
    bindThread("thr_custom_catalog", "market-analyst");

    const customPlainCompiled = compileMainAgentProfile("brand-editor", {
      description: "Brand editor",
      prompt: "You edit brand voice.",
      skills: ["ru-text", "copywriter"],
      mcpServers: ["gitnexus"],
    });
    const customCatalogCompiled = compileMainAgentProfile("market-analyst", {
      description: "Market analyst",
      prompt: "You analyze markets.",
      skills: ["tavily"],
    });

    const resolver = createNativeSpecialistSessionPolicy({
      db,
      bb: {
        storage: {
          kv: {
            get: async <T>(key: string) => kvMap.get(key) as T | undefined,
          },
        },
      } as never,
      ownedAgents: async () => ({
        "brand-editor": {
          compiled: customPlainCompiled,
          meta: { coreSkills: ["ru-check"] },
        },
        "market-analyst": {
          compiled: customCatalogCompiled,
          meta: { skillSections: ["Marketing"] },
        },
      }),
    });

    // 1. All 12 bundled employees: bounded (<= 20 skills), self-sufficient domain essentials, agent-tools included, zero cross-domain or dead skill leaks.
    const expectedDomainEssentials: Record<string, { mustInclude: string[]; mustExclude: string[] }> = {
      "seo-specialist": {
        mustInclude: ["env-catalog", "agent-tools", "seo-drmax-orchestrator", "seo-page-templates", "seo-tech-audit-kit", "google", "yandex"],
        mustExclude: ["blender-director", "roblox-toolkit", "kontur-elba", "mutagen", "xmlstock", "yandex-webmaster", "google-search-console"],
      },
      "growth-marketer": {
        mustInclude: ["env-catalog", "agent-tools", "mkt-end-to-end-analytics", "mkt-landing-cro", "mkt-yandex-direct-epk", "mkt-telegram-ads-method", "telegram-ads"],
        mustExclude: ["blender-director", "roblox-toolkit", "kontur-elba"],
      },
      "copy-lead": {
        mustInclude: ["env-catalog", "agent-tools", "copywriter", "copy-project-life", "site-copy-headlines", "site-copy-ux", "ru-text", "ru-check", "ai-detect"],
        mustExclude: ["blender-director", "roblox-toolkit", "kontur-elba", "seo-drmax-orchestrator"],
      },
      "design-lead": {
        mustInclude: ["env-catalog", "agent-tools", "project-design", "modern-web-guidance", "page-prototype", "web-design", "landing-page-design", "unslop", "ui-review"],
        mustExclude: ["blender-director", "kontur-elba", "telegram-user"],
      },
      "video-lead": {
        mustInclude: ["env-catalog", "agent-tools", "video-lead-playbook", "business-motion-film", "procedural-film", "video-to-reels", "hyperframes", "media-use"],
        mustExclude: ["kontur-elba", "seo-drmax-orchestrator", "roblox-toolkit"],
      },
      "3d-artist": {
        mustInclude: ["agent-tools", "blender-director", "blender-modeler", "hard-surface", "materials", "lighting", "rendering", "uv-workflow", "export-pipeline"],
        mustExclude: ["kontur-elba", "seo-drmax-orchestrator", "telegram-user"],
      },
      "game-dev": {
        mustInclude: ["agent-tools", "roblox-toolkit", "roblox-build", "roblox-design", "threejs-fundamentals", "godot-export", "unity-export"],
        mustExclude: ["kontur-elba", "seo-drmax-orchestrator", "edo-diadoc"],
      },
      "social-manager": {
        mustInclude: ["env-catalog", "agent-tools", "telegram-user", "telegram-rich-messages", "social-browser", "social-insights", "tg-search", "ig-post-assistant"],
        mustExclude: ["blender-director", "kontur-elba", "roblox-toolkit"],
      },
      "billing-assistant": {
        mustInclude: ["env-catalog", "agent-tools", "kontur-elba", "edo-diadoc", "cloudpayments"],
        mustExclude: ["edo-windows-diadoc", "blender-director", "seo-drmax-orchestrator"],
      },
      "visual-artist": {
        mustInclude: ["agent-tools", "image-prompting", "nano-banana", "xmlstock-image-research"],
        mustExclude: ["kontur-elba", "roblox-toolkit", "seo-drmax-orchestrator"],
      },
      "macos-operator": {
        mustInclude: ["env-catalog", "agent-tools", "computer-use", "browser-automation", "linux-sysadmin"],
        mustExclude: ["kontur-elba", "blender-director", "seo-drmax-orchestrator"],
      },
      tavily: {
        mustInclude: ["env-catalog", "agent-tools", "tavily", "copy-research", "alphaxiv"],
        mustExclude: ["kontur-elba", "blender-director", "roblox-toolkit"],
      },
    };

    expect(Object.keys(expectedDomainEssentials).sort()).toEqual(Object.keys(EMPLOYEES).sort());

    for (const [empId, checks] of Object.entries(expectedDomainEssentials)) {
      const policy = await resolver({
        thread: { id: `thr_${empId}` },
        project: { id: "proj_all_specs" },
        pluginMetadata: { role: "pm" },
      });
      expect(policy?.skills?.mode, empId).toBe("allow");
      const names = policy?.skills?.names ?? [];
      expect(names.length, `${empId} skill count (${names.length})`).toBeGreaterThanOrEqual(4);
      expect(names.length, `${empId} skill count (${names.length})`).toBeLessThanOrEqual(20);
      expect(names, empId).toEqual(expect.arrayContaining(checks.mustInclude));
      for (const forbidden of checks.mustExclude) {
        expect(names, `${empId} must not include ${forbidden}`).not.toContain(forbidden);
      }

      // Open-ended delegation (`specialist` / `agent-routine`) receives the same domain pack + `agent-tools` plugin.
      const openAccess = specialistProfileAccess(empId, undefined, { openEnded: true });
      expect(openAccess.bbPlugins, empId).toEqual(["agent-tools"]);
      expect(openAccess.skills, empId).toEqual(expect.arrayContaining(STANDALONE_SPECIALIST_SKILL_PACKS[empId]! as string[]));
      expect(openAccess.skills, empId).toContain("agent-tools");
    }

    // 2. Internal & architectural profiles: lead (0 skills!), workflow-architect, project-onboarder, and sub-roles.
    expect(await resolver({ thread: { id: "thr_lead" }, project: { id: "proj_all_specs" } })).toEqual({
      skills: { mode: "allow", names: [] },
    });
    expect(await resolver({ thread: { id: "thr_workflow-architect" }, project: { id: "proj_all_specs" } })).toEqual({
      skills: { mode: "allow", names: ["lane-pilot", "agent-tools"] },
    });
    expect(await resolver({ thread: { id: "thr_project-onboarder" }, project: { id: "proj_all_specs" } })).toEqual({
      skills: { mode: "allow", names: ["project-life", "project-onboard"] },
    });
    expect(await resolver({ thread: { id: "thr_nyquist-auditor" }, project: { id: "proj_all_specs" } })).toEqual({
      skills: { mode: "allow", names: ["lane-pilot"] },
    });
    for (const analyticalId of ["animator", "doc-classifier", "eval-auditor", "eval-planner", "framework-selector", "mempalace-curator"]) {
      expect(await resolver({ thread: { id: `thr_${analyticalId}` }, project: { id: "proj_all_specs" } }), analyticalId).toEqual({
        skills: { mode: "allow", names: [] },
      });
    }
    for (const resId of ["advisor-researcher", "ai-researcher", "domain-researcher"]) {
      const resPolicy = await resolver({ thread: { id: `thr_${resId}` }, project: { id: "proj_all_specs" } });
      expect(resPolicy?.skills?.names, resId).toEqual(["env-catalog", "tavily", "copy-research", "alphaxiv", "agent-tools"]);
      // Unedited stock sub-role in step-scoped workflow still receives its core `tavily` skill when row === undefined!
      expect(specialistProfileAccess(resId, undefined, { openEnded: false })).toEqual({ skills: ["tavily"] });
    }
    const uiResPolicy = await resolver({ thread: { id: "thr_ui-researcher" }, project: { id: "proj_all_specs" } });
    expect(uiResPolicy?.skills?.names).toEqual(["impeccable-ui", "ui-ux-pro-max", "ui-review", "project-design", "agent-tools"]);

    // 3. Custom owner-created agents: strictly scoped to declared skills (+ agent-tools only when skillSections is set).
    const plainCustomPolicy = await resolver({ thread: { id: "thr_custom_plain" }, project: { id: "proj_all_specs" } });
    expect(plainCustomPolicy?.skills?.names).toEqual(["env-catalog", "ru-text", "copywriter", "ru-check"]);
    const catalogCustomPolicy = await resolver({ thread: { id: "thr_custom_catalog" }, project: { id: "proj_all_specs" } });
    expect(catalogCustomPolicy?.skills?.names).toEqual(["env-catalog", "tavily", "agent-tools"]);

    // 4. Step-scoped workflow (`openEnded: false`) never leaks legacy disabled MCPs (`perplexity`, `studio-scenarios-mcp`) on seo-specialist,
    //    while honoring an explicit owner MCP override.
    const unchangedSeoStub = { compiled: compileMainAgentProfile("seo-specialist") };
    expect(specialistProfileAccess("seo-specialist", unchangedSeoStub, { openEnded: false })).toEqual({
      skills: ["seo-drmax-orchestrator"],
    });
    const customMcpSeo = {
      prompt: "Custom SEO prompt.",
      description: "Custom SEO",
      compiled: compileMainAgentProfile("seo-specialist", {
        prompt: "Custom SEO prompt.",
        description: "Custom SEO",
        mcpServers: ["mcp-gsc"],
      }),
    };
    expect(specialistProfileAccess("seo-specialist", customMcpSeo, { openEnded: false })).toEqual({
      skills: ["seo-drmax-orchestrator"],
      mcpServers: ["mcp-gsc"],
    });
  });
});
