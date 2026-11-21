// Owns: packages/workflow-engine/src/skill-files.ts, src/rooms/storage/skill-evolution-store.ts, src/rooms/night-graphs/server/companion-skill-merge.ts, src/rooms/night-graphs/category-taxonomy.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import {
  SKILL_MD_MAX_BYTES,
  SKILL_MD_MAX_LINES,
  casWriteSkillBundle,
  computeSkillBundleSha256,
  readSkillBundle,
  restoreSkillBundleSnapshot,
  type SkillBundleFile,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import { lintSkillDir } from "../../src/rooms/forge";
import {
  checkDeprojectization,
  lintAndVerifyCompanionSkill,
  renderCompanionSkillBundle,
  validateCategoryAndIdentityGeneralization,
  verifyNonDestructiveSkillMerge,
  type CompanionSkillSpec,
} from "../../src/rooms/night-graphs";
import {
  appendSkillEvolutionEvent,
  latestPublishedSkillEvolutionBySkill,
  latestPublishedSkillEvolutionForDraft,
  listLatestActivePublishedSkillEvolutionsForDraft,
  listSkillEvolutionsForDraft,
  openDatabase,
} from "../../src/rooms/plugin-db";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function makeTempSkillsRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-skill-evolve-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  forgetSecrets();
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("skill-files CAS storage, limits, symlink protection & v1 rollback", () => {
  const sampleV1Files: SkillBundleFile[] = [
    {
      path: "SKILL.md",
      text: [
        "---",
        "name: site-uikit-standard",
        'description: "Standard site UI kit structure. Use when building reusable web UI kits. Do not use for backend APIs."',
        "---",
        "",
        "# site-uikit-standard",
        "",
        "- [Golden Skeleton](references/golden-skeleton.md)",
        "- [QA Rubric](references/qa-rubric.md)",
        "- [Archetype: personal-brand](references/archetype-personal-brand.md)",
        "",
      ].join("\n"),
    },
    {
      path: "references/golden-skeleton.md",
      text: "# Golden Skeleton\n\n## 1. Color & Typography Tokens\n\nDefine scale.\n",
    },
    {
      path: "references/qa-rubric.md",
      text: "# QA Rubric\n\n- [ ] Contrast ratio >= 4.5:1\n",
    },
    {
      path: "references/archetype-personal-brand.md",
      text: "# Archetype Overlay: Personal Brand\n\n## Archetype Rules\n\n- Lead with authority bio.\n",
    },
  ];

  it("writes a skill bundle with CAS, detects stale SHA-256 conflicts without mutating disk, and supports v1 rollback", async () => {
    const skillsRoot = makeTempSkillsRoot();
    const skillId = "site-uikit-standard";
    const logs: string[] = [];

    const writeV1 = await casWriteSkillBundle(skillsRoot, skillId, sampleV1Files, null, { log: (m) => logs.push(m) });
    expect(writeV1.status).toBe("applied");
    expect(writeV1.beforeSha256).toBeNull();
    expect(writeV1.afterSha256).toBe(computeSkillBundleSha256(sampleV1Files));
    expect(writeV1.afterFiles.map((f) => f.path)).toEqual([
      "SKILL.md",
      "references/archetype-personal-brand.md",
      "references/golden-skeleton.md",
      "references/qa-rubric.md",
    ]);

    const readBack = await readSkillBundle(skillsRoot, skillId, { log: (m) => logs.push(m) });
    expect(readBack.exists).toBe(true);
    expect(readBack.bundleSha256).toBe(writeV1.afterSha256);
    expect(readBack.files.map((f) => f.path)).toEqual(writeV1.afterFiles.map((f) => f.path));

    // Stale expected SHA-256 -> conflict, no disk mutation
    const conflictRes = await casWriteSkillBundle(
      skillsRoot,
      skillId,
      sampleV1Files.map((f) => (f.path === "SKILL.md" ? { path: f.path, text: `${f.text}\n<!-- mutated -->\n` } : f)),
      "stale-sha-0000",
      { log: (m) => logs.push(m) },
    );
    expect(conflictRes.status).toBe("conflict");
    expect(conflictRes.afterSha256).toBeNull();
    expect(logs.some((l) => l.includes("WARN [workflowEngine.skillFiles] cas_conflict"))).toBe(true);
    expect(readFileSync(join(skillsRoot, skillId, "SKILL.md"), "utf8")).not.toContain("<!-- mutated -->");

    // Evolve v1 -> v2 adding references/archetype-ecommerce.md
    const v2Files: SkillBundleFile[] = [
      ...sampleV1Files,
      {
        path: "references/archetype-ecommerce.md",
        text: "# Archetype Overlay: Ecommerce\n\n## Archetype Rules\n\n- Include product card grid.\n",
      },
    ];
    const writeV2 = await casWriteSkillBundle(skillsRoot, skillId, v2Files, writeV1.afterSha256, { log: (m) => logs.push(m) });
    expect(writeV2.status).toBe("applied");
    expect(existsSync(join(skillsRoot, skillId, "references/archetype-ecommerce.md"))).toBe(true);

    // Restore v1 snapshot over v2 -> removes extra archetype-ecommerce.md and restores exact v1 SHA-256
    const restoreV1 = await restoreSkillBundleSnapshot(skillsRoot, skillId, sampleV1Files, { log: (m) => logs.push(m) });
    expect(restoreV1.status).toBe("applied");
    expect(restoreV1.afterSha256).toBe(writeV1.afterSha256);
    expect(existsSync(join(skillsRoot, skillId, "references/archetype-ecommerce.md"))).toBe(false);
    expect((await readSkillBundle(skillsRoot, skillId)).bundleSha256).toBe(writeV1.afterSha256);

    // Restore empty snapshot on v1 -> removes <skillsRoot>/<skillId> completely
    const restoreEmpty = await restoreSkillBundleSnapshot(skillsRoot, skillId, [], { log: (m) => logs.push(m) });
    expect(restoreEmpty.status).toBe("applied");
    expect(restoreEmpty.afterSha256).toBeNull();
    expect(existsSync(join(skillsRoot, skillId))).toBe(false);
    expect(logs.some((l) => l.includes("INFO [workflowEngine.skillFiles] snapshot_restored"))).toBe(true);
  });

  it("rejects path traversal, nested references, missing SKILL.md, byte/line overflow, and symlinks", async () => {
    const skillsRoot = makeTempSkillsRoot();
    const skillId = "guarded-skill";
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    // 1. Path traversal
    const traversal = await casWriteSkillBundle(skillsRoot, skillId, [
      sampleV1Files[0]!,
      { path: "../evil.md", text: "evil" },
    ], null, { log });
    expect(traversal.status).toBe("invalid");
    expect(traversal.reason).toContain("invalid_file_path");

    // 2. Nested references/sub/foo.md
    const nested = await casWriteSkillBundle(skillsRoot, skillId, [
      sampleV1Files[0]!,
      { path: "references/sub/foo.md", text: "nested" },
    ], null, { log });
    expect(nested.status).toBe("invalid");
    expect(nested.reason).toContain("invalid_file_path");

    // 3. Missing SKILL.md
    const missingSkillMd = await casWriteSkillBundle(skillsRoot, skillId, [
      { path: "references/golden-skeleton.md", text: "# Golden Skeleton\n" },
    ], null, { log });
    expect(missingSkillMd.status).toBe("invalid");
    expect(missingSkillMd.reason).toBe("missing_skill_md");

    // 4. SKILL.md >= 8192 bytes
    const oversizedBytes = await casWriteSkillBundle(skillsRoot, skillId, [
      { path: "SKILL.md", text: "a".repeat(SKILL_MD_MAX_BYTES) },
    ], null, { log });
    expect(oversizedBytes.status).toBe("invalid");
    expect(oversizedBytes.reason).toBe("skill_md_too_large");

    // 5. SKILL.md > 500 lines (under 8192 bytes)
    const tooManyLines = await casWriteSkillBundle(skillsRoot, skillId, [
      { path: "SKILL.md", text: Array.from({ length: SKILL_MD_MAX_LINES + 1 }, () => "x").join("\n") },
    ], null, { log });
    expect(tooManyLines.status).toBe("invalid");
    expect(tooManyLines.reason).toBe("skill_md_too_many_lines");

    // 6. Symlinked directory & symlinked target file
    const outsideDir = makeTempSkillsRoot();
    const outsideFile = join(outsideDir, "outside.md");
    writeFileSync(outsideFile, "# Outside\n", "utf8");

    const symSkillDir = "symlink-dir-skill";
    symlinkSync(outsideDir, join(skillsRoot, symSkillDir));
    const symDirRes = await casWriteSkillBundle(skillsRoot, symSkillDir, [sampleV1Files[0]!], null, { log });
    expect(symDirRes.status).toBe("invalid");
    expect(symDirRes.reason).toBe("symlink_forbidden");

    const symTargetSkill = "symlink-file-skill";
    mkdirSync(join(skillsRoot, symTargetSkill), { recursive: true });
    symlinkSync(outsideFile, join(skillsRoot, symTargetSkill, "SKILL.md"));
    const symFileRes = await casWriteSkillBundle(skillsRoot, symTargetSkill, [sampleV1Files[0]!], null, { log });
    expect(symFileRes.status).toBe("invalid");
    expect(symFileRes.reason).toBe("symlink_forbidden");

    const warnLogs = logs.filter((l) => l.includes("WARN [workflowEngine.skillFiles] invalid_path_or_size"));
    expect(warnLogs.length).toBeGreaterThanOrEqual(7);
  });
});

describe("skill-evolution-store append-only ledger & rollback resolution", () => {
  it("tracks staged -> published -> rolled_back, enforces append-only triggers, and redacts secrets in logs", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    cleanups.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);

    const secretToken = "sk-skill-ledger-secret-987654";
    registerSecrets([secretToken]);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const skillA = "brandbook-standard";
    const skillB = "site-uikit-standard";
    const filesA1 = [{ path: "SKILL.md", text: "# brandbook-standard v1\n" }];
    const filesA2 = [{ path: "SKILL.md", text: "# brandbook-standard v2\n" }];
    const filesB1 = [{ path: "SKILL.md", text: "# site-uikit-standard v1\n" }];

    const evStagedA1 = appendSkillEvolutionEvent(db, {
      draftId: "draft-1",
      draftVersion: 1,
      workflowId: `brandbook-${secretToken}`,
      skillId: skillA,
      operator: "create_suite",
      mergeMode: "create_bundle",
      status: "staged",
      candidateFiles: filesA1,
      beforeFiles: null,
      beforeBundleSha256: null,
      afterBundleSha256: "sha-a1",
      createdAt: 1_000,
    }, { log });

    const evPubA1 = appendSkillEvolutionEvent(db, {
      draftId: "draft-1",
      draftVersion: 1,
      workflowId: "brandbook",
      skillId: skillA,
      operator: "create_suite",
      mergeMode: "create_bundle",
      status: "published",
      candidateFiles: filesA1,
      beforeFiles: null,
      beforeBundleSha256: null,
      afterBundleSha256: "sha-a1",
      supersededWorkflowIds: ["legacy-brandbook"],
      supersededSnapshots: [{ workflowId: "legacy-brandbook", path: "/tmp/legacy.yaml", content: "id: legacy", sha256: "leg-sha" }],
      createdAt: 2_000,
    }, { log });

    const evPubA2 = appendSkillEvolutionEvent(db, {
      draftId: "draft-2",
      draftVersion: 1,
      workflowId: "brandbook",
      skillId: skillA,
      operator: "extend_module",
      mergeMode: "merge_core_and_overlay",
      status: "published",
      candidateFiles: filesA2,
      beforeFiles: filesA1,
      beforeBundleSha256: "sha-a1",
      afterBundleSha256: "sha-a2",
      createdAt: 3_000,
    }, { log });

    const evPubB1 = appendSkillEvolutionEvent(db, {
      draftId: "draft-2",
      draftVersion: 1,
      workflowId: "site-brief",
      skillId: skillB,
      operator: "create_suite",
      mergeMode: "create_bundle",
      status: "published",
      candidateFiles: filesB1,
      beforeFiles: null,
      beforeBundleSha256: null,
      afterBundleSha256: "sha-b1",
      createdAt: 3_500,
    }, { log });

    // Before rollback of draft-2/skillA
    expect(listSkillEvolutionsForDraft(db, "draft-1").map((e) => e.evolutionId)).toEqual([evPubA1.evolutionId, evStagedA1.evolutionId]);
    expect(listSkillEvolutionsForDraft(db, "draft-1", { status: "published" }).map((e) => e.evolutionId)).toEqual([evPubA1.evolutionId]);
    expect(listSkillEvolutionsForDraft(db, "draft-1", { draftVersion: 1 }).length).toBe(2);
    expect(latestPublishedSkillEvolutionForDraft(db, "draft-1")?.evolutionId).toBe(evPubA1.evolutionId);
    expect(listLatestActivePublishedSkillEvolutionsForDraft(db, "draft-2").map((e) => e.skillId)).toEqual([skillB, skillA]);
    expect(latestPublishedSkillEvolutionBySkill(db, skillA)?.evolutionId).toBe(evPubA2.evolutionId);

    // Rollback draft-2 v1 for skillA only
    appendSkillEvolutionEvent(db, {
      draftId: "draft-2",
      draftVersion: 1,
      workflowId: "brandbook",
      skillId: skillA,
      operator: "extend_module",
      mergeMode: "merge_core_and_overlay",
      status: "rolled_back",
      candidateFiles: filesA2,
      beforeFiles: filesA1,
      beforeBundleSha256: "sha-a1",
      afterBundleSha256: "sha-a1",
      createdAt: 4_000,
    }, { log });

    // Multi-skill draft-2 keeps skillB active, drops rolled-back skillA
    expect(listLatestActivePublishedSkillEvolutionsForDraft(db, "draft-2").map((e) => e.skillId)).toEqual([skillB]);
    // By skill, rollback of (draft-2, 1) falls back to active published (draft-1, 1)
    expect(latestPublishedSkillEvolutionBySkill(db, skillA)?.evolutionId).toBe(evPubA1.evolutionId);

    // Rollback draft-1 v1 for skillA -> now no published event remains
    appendSkillEvolutionEvent(db, {
      draftId: "draft-1",
      draftVersion: 1,
      workflowId: "brandbook",
      skillId: skillA,
      operator: "create_suite",
      mergeMode: "create_bundle",
      status: "rolled_back",
      candidateFiles: filesA1,
      beforeFiles: null,
      beforeBundleSha256: null,
      afterBundleSha256: null,
      createdAt: 5_000,
    }, { log });

    expect(latestPublishedSkillEvolutionForDraft(db, "draft-1")).toBeNull();
    expect(latestPublishedSkillEvolutionBySkill(db, skillA)).toBeNull();

    // SQLite append-only triggers forbid UPDATE & DELETE
    expect(() => db.prepare("UPDATE lane_pilot_skill_evolution SET status='published' WHERE evolution_id=?").run(evStagedA1.evolutionId))
      .toThrow(/skill evolution ledger is append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_skill_evolution WHERE evolution_id=?").run(evPubB1.evolutionId))
      .toThrow(/skill evolution ledger is append-only/);

    // Secret redaction in DEBUG/INFO logs
    const joinedLogs = logs.join("\n");
    expect(joinedLogs).toContain("DEBUG [storage.skillEvolution] staged");
    expect(joinedLogs).toContain("INFO [storage.skillEvolution] published");
    expect(joinedLogs).toContain("INFO [storage.skillEvolution] rolled_back");
    expect(joinedLogs).not.toContain(secretToken);
  });
});

describe("renderCompanionSkillBundle, lintSkillDir & verifyNonDestructiveSkillMerge (v1 -> v2 -> v3)", () => {
  it("renders brandbook-standard v1 cleanly and merges v1 -> v2 without dropping sections", () => {
    const logs: string[] = [];
    const v1Spec: CompanionSkillSpec = {
      skillId: "brandbook-standard",
      workflowIds: ["brandbook"],
      mergeMode: "create_bundle",
      summary: "Universal brandbook standard covering core identity sections and visual tokens.",
      whenToUse: "creating or auditing a brandbook deliverable",
      whenNotToUse: "writing backend infrastructure or database migrations",
      coreRules: [
        "Establish verbal positioning before choosing color or typography tokens.",
        "Specify exact hex, RGB, and scale ratios for every design token.",
      ],
      goldenSkeletonSections: [
        "Brand Essence",
        "Logo & Clearspace",
        "Color & Typography Tokens",
      ],
      qaRubricChecks: [
        "Logo clearspace rule is explicit and measurable.",
        "Every primary and surface color has WCAG contrast notes.",
      ],
      archetypeOverlays: [],
    };

    const v1 = renderCompanionSkillBundle(v1Spec);
    const v1Lint = lintSkillDir(v1.files);
    expect(v1Lint.errors).toEqual([]);
    expect(v1Lint.warnings).toEqual([]);

    const skillMd = v1.files.find((f) => f.path === "SKILL.md")!.text;
    expect(Buffer.byteLength(skillMd, "utf8")).toBeLessThan(SKILL_MD_MAX_BYTES);
    expect(skillMd).toMatch(/^description:\s*"[^"]*Use when[^"]*(?:Do not use for|not for)[^"]*"$/m);
    for (const refFile of v1.files.filter((f) => f.path.startsWith("references/"))) {
      expect(skillMd).toContain(refFile.path);
      expect(refFile.text).not.toMatch(/references\/[A-Za-z0-9_.-]+\.md/);
      expect(refFile.text).not.toMatch(/\]\([^)]+\.md\)/);
    }

    const v1Verdict = lintAndVerifyCompanionSkill(v1, null, { log: (m) => logs.push(m) });
    expect(v1Verdict.ok).toBe(true);
    expect(v1Verdict.findings).toEqual([]);

    // Evolve v1 -> v2 adding Tone of Voice, Motion & Micro-interactions, and archetype-b2b-service
    const v2Spec: CompanionSkillSpec = {
      ...v1Spec,
      mergeMode: "merge_core_and_overlay",
      coreRules: ["Define micro-interaction timing alongside motion principles."],
      goldenSkeletonSections: [
        "Tone of Voice",
        "Motion & Micro-interactions",
      ],
      qaRubricChecks: ["Tone of voice includes do/don't copy examples."],
      archetypeOverlays: [
        {
          slug: "b2b-service",
          title: "B2B Service",
          whenToUse: "building brandbooks for B2B consulting or service companies",
          rules: ["Include enterprise trust badges and case-study layout guidance."],
        },
      ],
    };

    const v2 = renderCompanionSkillBundle(v2Spec, v1.files);
    const v2Verdict = lintAndVerifyCompanionSkill(v2, v1.files, { log: (m) => logs.push(m) });
    expect(v2Verdict.ok).toBe(true);
    expect(v2Verdict.findings).toEqual([]);
    expect(v2Verdict.warnings).toEqual([]);

    const v2Skeleton = v2.files.find((f) => f.path === "references/golden-skeleton.md")!.text;
    expect(v2Skeleton).toContain("## 1. Brand Essence");
    expect(v2Skeleton).toContain("## 2. Logo & Clearspace");
    expect(v2Skeleton).toContain("## 3. Color & Typography Tokens");
    expect(v2Skeleton).toContain("## 4. Tone of Voice");
    expect(v2Skeleton).toContain("## 5. Motion & Micro-interactions");
    expect(v2.files.some((f) => f.path === "references/archetype-b2b-service.md")).toBe(true);
    expect(v2.files.find((f) => f.path === "SKILL.md")!.text).toContain("references/archetype-b2b-service.md");
  });

  it("evolves site-uikit-standard across v1 -> v2 -> v3 preserving all archetype overlays and blocks destructive merges", () => {
    const baseSpec: Omit<CompanionSkillSpec, "mergeMode" | "archetypeOverlays"> = {
      skillId: "site-uikit-standard",
      workflowIds: ["site-brief"],
      summary: "Universal web UI kit and section specification standard.",
      whenToUse: "designing responsive websites and reusable UI kits",
      whenNotToUse: "native mobile hardware drivers or database tuning",
      coreRules: ["Lock spacing, typography, and contrast tokens before composing page sections."],
      goldenSkeletonSections: ["Color & Typography Tokens", "Component States", "Responsive Grid"],
      qaRubricChecks: ["Mobile 375px layout renders without horizontal overflow."],
    };

    const v1 = renderCompanionSkillBundle({
      ...baseSpec,
      mergeMode: "create_bundle",
      archetypeOverlays: [{
        slug: "personal-brand",
        title: "Personal Brand",
        whenToUse: "designing expert or founder personal-brand sites",
        rules: ["Reserve hero slot for authority bio and credential bar."],
      }],
    });
    expect(lintAndVerifyCompanionSkill(v1, null).ok).toBe(true);

    const v2 = renderCompanionSkillBundle({
      ...baseSpec,
      mergeMode: "merge_core_and_overlay",
      archetypeOverlays: [{
        slug: "ecommerce",
        title: "Ecommerce",
        whenToUse: "designing online storefronts and product catalogs",
        rules: ["Include variant swatch states and sticky cart summary."],
      }],
    }, v1.files);
    expect(lintAndVerifyCompanionSkill(v2, v1.files).ok).toBe(true);

    const v3 = renderCompanionSkillBundle({
      ...baseSpec,
      mergeMode: "merge_core_and_overlay",
      archetypeOverlays: [{
        slug: "high-ticket-leadgen",
        title: "High-Ticket Leadgen",
        whenToUse: "designing high-ticket B2C/B2B service quote funnels",
        rules: ["Place multi-step estimator or consultation CTA above the fold."],
      }],
    }, v2.files);

    const v3Verdict = lintAndVerifyCompanionSkill(v3, v2.files);
    expect(v3Verdict.ok).toBe(true);
    expect(v3Verdict.warnings).toEqual([]);
    const v3Paths = v3.files.map((f) => f.path);
    expect(v3Paths).toContain("references/archetype-personal-brand.md");
    expect(v3Paths).toContain("references/archetype-ecommerce.md");
    expect(v3Paths).toContain("references/archetype-high-ticket-leadgen.md");

    const v3SkillMd = v3.files.find((f) => f.path === "SKILL.md")!.text;
    expect(v3SkillMd).toContain("references/archetype-personal-brand.md");
    expect(v3SkillMd).toContain("references/archetype-ecommerce.md");
    expect(v3SkillMd).toContain("references/archetype-high-ticket-leadgen.md");

    // Destructive edit 1: drop "Color & Typography Tokens" from references/golden-skeleton.md
    const logs: string[] = [];
    const droppedSectionFiles = v3.files.map((f) =>
      f.path === "references/golden-skeleton.md"
        ? {
            path: f.path,
            text: "# Golden Skeleton: site-uikit-standard\n\n## 1. Component States\n\nStates.\n\n## 2. Responsive Grid\n\nGrid.\n",
          }
        : f,
    );
    expect(verifyNonDestructiveSkillMerge(v3.files, droppedSectionFiles).map((f) => f.code)).toContain("missing_golden_section");
    const blockedSectionVerdict = lintAndVerifyCompanionSkill(
      { ...v3, files: droppedSectionFiles },
      v3.files,
      { log: (m) => logs.push(m) },
    );
    expect(blockedSectionVerdict.ok).toBe(false);
    expect(blockedSectionVerdict.findings.map((f) => f.code)).toContain("missing_golden_section");
    expect(logs.some((l) => l.includes("WARN [nightGraphs.skillMerge] destructive_merge_blocked"))).toBe(true);

    // Destructive edit 2: drop references/archetype-personal-brand.md
    const droppedOverlayLogs: string[] = [];
    const droppedOverlayFiles = v3.files.filter((f) => f.path !== "references/archetype-personal-brand.md");
    expect(verifyNonDestructiveSkillMerge(v3.files, droppedOverlayFiles).map((f) => f.code)).toContain("dropped_archetype_overlay");
    const blockedOverlayVerdict = lintAndVerifyCompanionSkill(
      { ...v3, files: droppedOverlayFiles },
      v3.files,
      { log: (m) => droppedOverlayLogs.push(m) },
    );
    expect(blockedOverlayVerdict.ok).toBe(false);
    expect(blockedOverlayVerdict.findings.map((f) => f.code)).toContain("dropped_archetype_overlay");
    expect(droppedOverlayLogs.some((l) => l.includes("WARN [nightGraphs.skillMerge] destructive_merge_blocked"))).toBe(true);
  });
});

describe("category-taxonomy & checkDeprojectization anti-niche gate", () => {
  it("rejects narrow niche categories, workflow IDs, and names while logging niche_rejected", () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    const pbsCategory = {
      id: "site-brief",
      name: { en: "Site Brief", ru: "Бриф сайта" },
      category: { id: "personal-brand-site", label: { en: "Personal Brand Sites", ru: "Сайты личного бренда" } },
    };
    const pbsViolations = validateCategoryAndIdentityGeneralization(pbsCategory, { log });
    expect(pbsViolations.map((v) => v.code)).toContain("niche_category_violation");
    expect(checkDeprojectization(pbsCategory, { log }).findings.map((f) => f.code)).toContain("niche_category_violation");

    const windowsCategory = {
      id: "site-design",
      name: { en: "Site Design", ru: "Дизайн сайта" },
      category: { id: "plastic-windows-design", label: { en: "Plastic Windows Design", ru: "Дизайн пластиковых окон" } },
    };
    expect(validateCategoryAndIdentityGeneralization(windowsCategory, { log }).map((v) => v.code)).toContain("niche_category_violation");
    expect(checkDeprojectization(windowsCategory, { log }).findings.map((f) => f.code)).toContain("niche_category_violation");

    const pbsWorkflowId = {
      id: "pbs-brief",
      name: { en: "Universal Brief", ru: "Универсальный бриф" },
      category: { id: "websites", label: { en: "Websites & Web Design", ru: "Сайты и веб-дизайн" } },
    };
    expect(validateCategoryAndIdentityGeneralization(pbsWorkflowId, { log }).map((v) => v.code)).toContain("niche_workflow_identity");
    expect(checkDeprojectization(pbsWorkflowId, { log }).findings.map((f) => f.code)).toContain("niche_workflow_identity");

    const fachwerkName = {
      id: "landing-flow",
      name: { en: "Fachwerk House Landing", ru: "Лендинг фахверковых домов" },
      category: { id: "websites", label: { en: "Websites & Web Design", ru: "Сайты и веб-дизайн" } },
    };
    expect(validateCategoryAndIdentityGeneralization(fachwerkName, { log }).map((v) => v.code)).toContain("niche_workflow_identity");
    expect(checkDeprojectization(fachwerkName, { log }).findings.map((f) => f.code)).toContain("niche_workflow_identity");

    expect(logs.some((l) => l.includes("WARN [nightGraphs.taxonomy] niche_rejected"))).toBe(true);
  });

  it("accepts broad universal categories and reusable workflow identities with project_archetype input", () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const siteBriefDef = {
      id: "site-brief",
      name: { en: "Site Brief & Architecture", ru: "Бриф и архитектура сайта" },
      category: { id: "websites", label: { en: "Websites & Web Design", ru: "Сайты и веб-дизайн" } },
      inputs: {
        project_archetype: { type: "string", default: "general" },
      },
    };
    const brandbookDef = {
      id: "brandbook",
      name: { en: "Brandbook Standard", ru: "Стандарт брендбука" },
      category: { id: "websites", label: { en: "Websites & Web Design", ru: "Сайты и веб-дизайн" } },
      inputs: {
        project_archetype: { type: "string", default: "general" },
      },
    };

    expect(validateCategoryAndIdentityGeneralization(siteBriefDef, { log })).toEqual([]);
    expect(checkDeprojectization(siteBriefDef, { log })).toEqual({ ok: true, workflowId: "site-brief", findings: [] });
    expect(validateCategoryAndIdentityGeneralization(brandbookDef, { log })).toEqual([]);
    expect(checkDeprojectization(brandbookDef, { log })).toEqual({ ok: true, workflowId: "brandbook", findings: [] });
  });
});
