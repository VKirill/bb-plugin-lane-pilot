import { redactKnown } from "@lane-pilot/kit";
import {
  SKILL_MD_MAX_BYTES,
  SKILL_MD_MAX_LINES,
  sortSkillBundleFiles,
  validateSkillBundleFiles,
  type SkillBundleFile,
} from "@lane-pilot/workflow-engine";
import { lintSkillDir } from "../../forge";
import { checkDeprojectization, type DeprojectizeContext } from "../deprojectize";
import type { CompanionArchetypeOverlaySpec, CompanionSkillSpec } from "../process-blueprint";

export type CompanionSkillCandidate = {
  skillId: string;
  workflowIds: string[];
  mergeMode: "create_bundle" | "merge_core_and_overlay";
  files: SkillBundleFile[];
};

export type NonDestructiveMergeFindingCode =
  | "missing_golden_section"
  | "missing_qa_check"
  | "dropped_archetype_overlay"
  | "skill_lint_error"
  | "deprojectize_error";

export type NonDestructiveMergeFinding = { code: NonDestructiveMergeFindingCode; detail: string };
export type NonDestructiveMergeVerdict = { ok: boolean; skillId: string; findings: NonDestructiveMergeFinding[]; warnings: string[] };

const ARCHETYPE_FILE_RE = /^references\/archetype-[a-z0-9][a-z0-9-]{0,47}\.md$/;
const NESTED_REF_RE = /\]\(((?:\.\/)?(?:references\/)?[A-Za-z0-9_.-]+\.md)\)|references\/[A-Za-z0-9_.-]+\.md/;
const normWs = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
const normHeading = (s: string): string => normWs(s.replace(/^\d+\.\s*/, ""));
const stripRefLinks = (s: string): string => s.replace(/references\/[A-Za-z0-9_./-]+/g, "the companion skill");

function extractMatches(markdown: string | undefined, re: RegExp, transform?: (s: string) => string): string[] {
  if (!markdown) return [];
  const out: string[] = [];
  for (const m of markdown.matchAll(re)) {
    const val = (transform ? transform(m[1]!) : m[1]!).trim();
    if (val) out.push(val);
  }
  return out;
}

function extractBullets(markdown: string | undefined, sectionHeading?: string): string[] {
  if (!markdown) return [];
  let slice = markdown;
  if (sectionHeading) {
    const idx = markdown.indexOf(`## ${sectionHeading}`);
    if (idx < 0) return [];
    const rest = markdown.slice(idx + sectionHeading.length + 3);
    const nextHeading = rest.search(/^##\s+/m);
    slice = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  }
  return extractMatches(slice, /^-\s+(.+)$/gm);
}

function mergeOrderedUnique(existing: readonly string[], incoming: readonly string[], normalize: (s: string) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...existing, ...incoming]) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalize(trimmed);
    if (!seen.has(key)) { seen.add(key); out.push(trimmed); }
  }
  return out;
}

function buildDescription(spec: CompanionSkillSpec): string {
  const summary = spec.summary.trim().replace(/\s+/g, " ").slice(0, 320);
  const when = spec.whenToUse.trim().replace(/^use\s+(?:this\s+skill\s+)?(?:when|for)\s+/i, "").replace(/\s+/g, " ").slice(0, 280);
  const notFor = spec.whenNotToUse.trim().replace(/^(?:do\s+not\s+use(?:\s+for)?|not\s+for|skip:?)\s+/i, "").replace(/\s+/g, " ").slice(0, 220);
  let desc = `${summary}${summary.endsWith(".") ? "" : "."} Use when ${when || `working on ${spec.skillId}`}. Do not use for ${notFor || `tasks unrelated to ${spec.skillId}`}.`;
  if (desc.length < 50) desc = `${desc} Follow the golden skeleton and QA rubric.`;
  return desc.slice(0, 900);
}

function renderGoldenSkeleton(skillId: string, sections: readonly string[]): string {
  const effective = sections.length > 0 ? sections : ["Deliverable Overview"];
  const blocks = effective.map((raw, idx) => {
    const title = stripRefLinks(raw.replace(/^\d+\.\s*/, "").trim());
    return `## ${idx + 1}. ${title}\n\nProvide concrete, verifiable content and structured details for ${title}.`;
  });
  return `# Golden Skeleton: ${skillId}\n\nMandatory ordered artifact structure. Preserve every numbered section in this order.\n\n${blocks.join("\n\n")}\n`;
}

function renderQaRubric(skillId: string, checks: readonly string[]): string {
  const effective = checks.length > 0
    ? checks.map((c) => stripRefLinks(c.replace(/^-\s+\[[ xX]\]\s*/, "").trim()))
    : ["Every golden skeleton section is complete and verified against workflow inputs."];
  return `# QA Rubric: ${skillId}\n\nCritic verification checklist before passing this deliverable.\n\n${effective.map((c) => `- [ ] ${c}`).join("\n")}\n`;
}

function renderArchetypeOverlay(overlay: CompanionArchetypeOverlaySpec, existingText?: string): string {
  const existingRules = existingText ? extractBullets(existingText, "Archetype Rules") : [];
  const merged = mergeOrderedUnique(existingRules, overlay.rules.map(stripRefLinks), normWs);
  const rules = merged.length > 0 ? merged : [`Apply ${overlay.title} constraints while keeping the universal golden skeleton intact.`];
  return `# Archetype Overlay: ${overlay.title}\n\nWhen to apply: ${stripRefLinks(overlay.whenToUse)}\n\n## Archetype Rules\n\n${rules.map((r) => `- ${r}`).join("\n")}\n`;
}

function renderSkillMd(spec: CompanionSkillSpec, coreRules: readonly string[], archetypePaths: readonly string[]): string {
  const header = [
    "---", `name: ${spec.skillId}`, `description: ${JSON.stringify(buildDescription(spec))}`, "---", "",
    `# ${spec.skillId}`, "", "## Scope", "", `- Use when: ${spec.whenToUse}`, `- Do not use: ${spec.whenNotToUse}`, "", "## Core Rules", "",
  ].join("\n");
  const refs = [
    "", "## References", "",
    "- [Golden Skeleton](references/golden-skeleton.md) — mandatory ordered artifact sections",
    "- [QA Rubric](references/qa-rubric.md) — pre-delivery critic checklist",
    ...archetypePaths.map((p) => `- [Archetype: ${p.replace(/^references\/archetype-/, "").replace(/\.md$/, "")}](${p}) — domain archetype overlay rules`),
    "",
  ].join("\n");

  const effectiveRules = coreRules.length > 0
    ? coreRules
    : ["Follow the ordered structure in references/golden-skeleton.md and verify every check in references/qa-rubric.md."];
  const keptLines: string[] = [];
  const maxBodyBytes = SKILL_MD_MAX_BYTES - 256;
  for (const rule of effectiveRules) {
    const line = `- ${rule.trim().slice(0, 400)}`;
    const candidate = `${header}${[...keptLines, line].join("\n")}${refs}`;
    if (Buffer.byteLength(candidate, "utf8") < maxBodyBytes && candidate.split("\n").length <= SKILL_MD_MAX_LINES) keptLines.push(line);
  }
  return `${header}${keptLines.join("\n")}${refs}`;
}

/** Deterministically renders or non-destructively merges a `CompanionSkillSpec` into a sorted `SkillBundleFile[]` bundle. */
export function renderCompanionSkillBundle(
  spec: CompanionSkillSpec,
  existingFiles?: readonly SkillBundleFile[] | null,
): CompanionSkillCandidate {
  const isMerge = spec.mergeMode === "merge_core_and_overlay" && Boolean(existingFiles && existingFiles.length > 0);
  const existingMap = new Map((existingFiles ?? []).map((f) => [f.path, f.text]));

  const goldenSections = mergeOrderedUnique(
    isMerge ? extractMatches(existingMap.get("references/golden-skeleton.md"), /^##\s+(.+)$/gm, (h) => h.replace(/^\d+\.\s*/, "")) : [],
    spec.goldenSkeletonSections.map((s) => s.replace(/^\d+\.\s*/, "")),
    normHeading,
  );
  const qaChecks = mergeOrderedUnique(
    isMerge ? extractMatches(existingMap.get("references/qa-rubric.md"), /^-\s+\[[ xX]\]\s+(.+)$/gm) : [],
    spec.qaRubricChecks.map((c) => c.replace(/^-\s+\[[ xX]\]\s*/, "")),
    normWs,
  );
  const coreRules = mergeOrderedUnique(isMerge ? extractBullets(existingMap.get("SKILL.md"), "Core Rules") : [], spec.coreRules, normWs);

  const archetypeFiles = new Map<string, string>();
  if (isMerge) for (const [path, text] of existingMap) if (ARCHETYPE_FILE_RE.test(path)) archetypeFiles.set(path, text);
  for (const overlay of spec.archetypeOverlays) {
    const path = `references/archetype-${overlay.slug}.md`;
    if (!ARCHETYPE_FILE_RE.test(path)) continue;
    archetypeFiles.set(path, renderArchetypeOverlay(overlay, isMerge ? archetypeFiles.get(path) : undefined));
  }

  const archetypePaths = [...archetypeFiles.keys()].sort((a, b) => a.localeCompare(b));
  const files: SkillBundleFile[] = [
    { path: "SKILL.md", text: renderSkillMd(spec, coreRules, archetypePaths) },
    { path: "references/golden-skeleton.md", text: renderGoldenSkeleton(spec.skillId, goldenSections) },
    { path: "references/qa-rubric.md", text: renderQaRubric(spec.skillId, qaChecks) },
    ...archetypePaths.map((path) => ({ path, text: archetypeFiles.get(path)! })),
  ];

  return { skillId: spec.skillId, workflowIds: [...new Set(spec.workflowIds)], mergeMode: spec.mergeMode, files: sortSkillBundleFiles(files) };
}

/** Ensures an updated skill bundle preserves all previously approved skeleton headings, QA checks, and archetype files. */
export function verifyNonDestructiveSkillMerge(
  existingFiles: readonly SkillBundleFile[] | null | undefined,
  candidateFiles: readonly SkillBundleFile[],
): NonDestructiveMergeFinding[] {
  if (!existingFiles || existingFiles.length === 0) return [];
  const findings: NonDestructiveMergeFinding[] = [];
  const prevMap = new Map(existingFiles.map((f) => [f.path, f.text]));
  const nextMap = new Map(candidateFiles.map((f) => [f.path, f.text]));

  const nextHeadings = new Set(extractMatches(nextMap.get("references/golden-skeleton.md"), /^##\s+(.+)$/gm, (h) => h.replace(/^\d+\.\s*/, "")).map(normHeading));
  for (const heading of extractMatches(prevMap.get("references/golden-skeleton.md"), /^##\s+(.+)$/gm, (h) => h.replace(/^\d+\.\s*/, ""))) {
    if (!nextHeadings.has(normHeading(heading))) {
      findings.push({ code: "missing_golden_section", detail: `Golden skeleton section "${heading}" from existing skill was removed` });
    }
  }

  const nextChecks = new Set(extractMatches(nextMap.get("references/qa-rubric.md"), /^-\s+\[[ xX]\]\s+(.+)$/gm).map(normWs));
  for (const check of extractMatches(prevMap.get("references/qa-rubric.md"), /^-\s+\[[ xX]\]\s+(.+)$/gm)) {
    if (!nextChecks.has(normWs(check))) {
      findings.push({ code: "missing_qa_check", detail: `QA rubric check "${check}" from existing skill was removed` });
    }
  }

  for (const path of prevMap.keys()) {
    if (ARCHETYPE_FILE_RE.test(path) && !nextMap.has(path)) {
      findings.push({ code: "dropped_archetype_overlay", detail: `Existing archetype overlay "${path}" was dropped` });
    }
  }
  return findings;
}

/** Validates skill bundle structure, `lintSkillDir`, de-projectization, and non-destructive merge invariants. */
export function lintAndVerifyCompanionSkill(
  candidate: CompanionSkillCandidate,
  existingFiles: readonly SkillBundleFile[] | null | undefined,
  options?: { deprojectize?: DeprojectizeContext; log?: (msg: string) => void },
): NonDestructiveMergeVerdict {
  const findings: NonDestructiveMergeFinding[] = [];
  const bundleCheck = validateSkillBundleFiles(candidate.skillId, candidate.files);
  if (!bundleCheck.ok) findings.push({ code: "skill_lint_error", detail: `validateSkillBundleFiles: ${bundleCheck.reason}` });

  const lint = lintSkillDir(candidate.files);
  for (const err of lint.errors) findings.push({ code: "skill_lint_error", detail: err });
  for (const warn of lint.warnings) {
    if (/too_long|body_size|8 KB|8,192|500 lines/i.test(warn)) findings.push({ code: "skill_lint_error", detail: warn });
  }
  for (const file of candidate.files) {
    if (file.path.startsWith("references/") && NESTED_REF_RE.test(file.text)) {
      findings.push({ code: "skill_lint_error", detail: `${file.path}: nested reference link inside references/ is forbidden` });
    }
  }

  const deproj = checkDeprojectization({ id: candidate.skillId, name: candidate.skillId, files: candidate.files }, options?.deprojectize);
  for (const f of deproj.findings) findings.push({ code: "deprojectize_error", detail: `${f.code} (${f.path}): ${f.detail}` });

  const mergeFindings = verifyNonDestructiveSkillMerge(existingFiles, candidate.files);
  findings.push(...mergeFindings);

  const skillMd = candidate.files.find((f) => f.path === "SKILL.md")?.text ?? "";
  options?.log?.(`DEBUG [nightGraphs.skillMerge] bundle_linted ${redactKnown(JSON.stringify({
    skillId: candidate.skillId,
    bytes: Buffer.byteLength(skillMd, "utf8"),
    lines: skillMd ? skillMd.split("\n").length : 0,
    overlayCount: candidate.files.filter((f) => ARCHETYPE_FILE_RE.test(f.path)).length,
    errors: findings.filter((f) => f.code === "skill_lint_error" || f.code === "deprojectize_error").length,
    warnings: lint.warnings.length,
  }))}`);

  if (mergeFindings.length > 0) {
    options?.log?.(`WARN [nightGraphs.skillMerge] destructive_merge_blocked ${redactKnown(JSON.stringify({
      skillId: candidate.skillId, codes: [...new Set(mergeFindings.map((f) => f.code))],
    }))}`);
  }

  return { ok: findings.length === 0, skillId: candidate.skillId, findings, warnings: lint.warnings };
}
