import { redactKnown } from "@lane-pilot/kit";
import {
  SKILL_MD_MAX_BYTES, SKILL_MD_MAX_LINES, dice, grams, sortSkillBundleFiles, stems, validateSkillBundleFiles,
  type SkillBundleFile,
} from "@lane-pilot/workflow-engine";
import { lintSkillDir } from "../../forge";
import { checkDeprojectization, type DeprojectizeContext } from "../deprojectize";
import type { CompanionArchetypeOverlaySpec, CompanionSkillSpec } from "../process-blueprint";

export type CompanionSkillCandidate = { skillId: string; workflowIds: string[]; mergeMode: "create_bundle" | "merge_core_and_overlay"; files: SkillBundleFile[] };
export type NonDestructiveMergeFindingCode = "missing_golden_section" | "missing_qa_check" | "dropped_archetype_overlay" | "skill_lint_error" | "deprojectize_error";
export type NonDestructiveMergeFinding = { code: NonDestructiveMergeFindingCode; detail: string };
export type NonDestructiveMergeVerdict = { ok: boolean; skillId: string; findings: NonDestructiveMergeFinding[]; warnings: string[] };

export const MAX_GOLDEN_SKELETON_SECTIONS = 14;
export const MAX_CORE_RULES = 16;

const ARCHETYPE_FILE_RE = /^references\/archetype-[a-z0-9][a-z0-9-]{0,47}\.md$/;
const NESTED_REF_RE = /\]\(((?:\.\/)?(?:references\/)?[A-Za-z0-9_.-]+\.md)\)|references\/[A-Za-z0-9_.-]+\.md/;
const OPTIONAL_TAG_RE = /\[optional:\s*when\s+([^\]]+)\]/i;
const WEAK_STEMS = new Set(["report", "log", "record", "summary", "section", "overview", "spec", "specs", "check", "checks", "checklist", "list", "role", "item", "artifact", "details", "file", "files"].flatMap((w) => stems(w)));

const normWs = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
const normHeading = (s: string): string => normWs(s.replace(/^\d+\.\s*/, ""));
const stripRefLinks = (s: string): string => s.replace(/references\/[A-Za-z0-9_./-]+/g, "the companion skill");
const formatWithOptional = (clean: string, opt: string | null): string => (opt ? `${clean} [optional: when ${opt}]` : clean);

function parseOptionalTag(raw: string): { clean: string; optionalCondition: string | null } {
  const stripped = raw.trim().replace(/^\d+\.\s*/, "").replace(/^-\s+\[[ xX]\]\s*/, "").trim();
  const match = OPTIONAL_TAG_RE.exec(stripped);
  if (!match) return { clean: stripped.replace(/\s+/g, " "), optionalCondition: null };
  const optionalCondition = match[1]!.trim().replace(/\s+/g, " ") || null;
  return { clean: stripped.replace(OPTIONAL_TAG_RE, "").replace(/\s+/g, " ").trim(), optionalCondition };
}

function topicStems(text: string): string[] {
  const raw = [...new Set(stems(parseOptionalTag(text).clean))];
  const filtered = raw.filter((s) => !WEAK_STEMS.has(s));
  return filtered.length > 0 ? filtered : raw;
}

function mergeTopicPair(existingItem: string, nextItem: string): string {
  const a = parseOptionalTag(existingItem);
  const b = parseOptionalTag(nextItem);
  const sa = topicStems(a.clean).length;
  const sb = topicStems(b.clean).length;
  const clean = sb > sa || (sb === sa && b.clean.length > a.clean.length) ? b.clean : a.clean;
  const opt = a.optionalCondition && b.optionalCondition
    ? (a.optionalCondition.length >= b.optionalCondition.length ? a.optionalCondition : b.optionalCondition)
    : (a.optionalCondition ?? b.optionalCondition);
  return formatWithOptional(clean, opt);
}

/** Semantic topic equivalence predicate combining Szymkiewicz–Simpson stem containment and trigram Dice similarity. */
export function isSameSkillTopic(a: string, b: string): boolean {
  const ca = normHeading(parseOptionalTag(a).clean);
  const cb = normHeading(parseOptionalTag(b).clean);
  if (!ca || !cb) return ca === cb;
  if (ca === cb) return true;
  const sa = topicStems(a);
  const sb = topicStems(b);
  if (sa.length === 0 || sb.length === 0) return false;
  const setB = new Set(sb);
  const inter = sa.filter((x) => setB.has(x));
  const minLen = Math.min(sa.length, sb.length);
  if (minLen >= 2 && inter.length / minLen >= 0.8) return true;
  if (minLen === 1 && inter.length === 1 && inter[0]!.length >= 4) return true;
  return dice(grams(sa.join(" ")), grams(sb.join(" "))) >= 0.62;
}

function coalesceBestPair(items: string[]): void {
  let bestI = items.length - 2;
  let bestJ = items.length - 1;
  let bestScore: [number, number, number] = [-1, -1, -1];
  for (let i = 0; i < items.length; i += 1) {
    const si = topicStems(items[i]!);
    const optI = Boolean(parseOptionalTag(items[i]!).optionalCondition);
    for (let j = i + 1; j < items.length; j += 1) {
      const sj = topicStems(items[j]!);
      const setJ = new Set(sj);
      const overlap = si.filter((x) => setJ.has(x)).length;
      const sameOpt = optI === Boolean(parseOptionalTag(items[j]!).optionalCondition) ? 1 : 0;
      const containment = overlap / Math.max(1, Math.min(si.length, sj.length));
      const better = sameOpt > bestScore[0]
        || (sameOpt === bestScore[0] && (overlap > bestScore[1] || (overlap === bestScore[1] && (overlap > 0 ? containment > bestScore[2] : true))));
      if (better) { bestScore = [sameOpt, overlap, containment]; bestI = i; bestJ = j; }
    }
  }
  const pI = parseOptionalTag(items[bestI]!);
  const pJ = parseOptionalTag(items[bestJ]!);
  const opt = pI.optionalCondition && pJ.optionalCondition
    ? (pI.optionalCondition.length >= pJ.optionalCondition.length ? pI.optionalCondition : pJ.optionalCondition)
    : null;
  items[bestI] = formatWithOptional(`${pI.clean}; ${pJ.clean}`, opt);
  items.splice(bestJ, 1);
}

/** Deduplicates semantically equivalent items and coalesces excess entries down to `options.maxItems` if provided. */
export function compactSemanticItems(items: readonly string[], options?: { maxItems?: number }): { items: string[]; collapsedCount: number } {
  const deduped: string[] = [];
  let collapsedCount = 0;
  for (const raw of items) {
    const parsed = parseOptionalTag(raw);
    if (!parsed.clean) continue;
    const normalized = formatWithOptional(parsed.clean, parsed.optionalCondition);
    const matchIdx = deduped.findIndex((existing) => isSameSkillTopic(existing, normalized));
    if (matchIdx >= 0) { deduped[matchIdx] = mergeTopicPair(deduped[matchIdx]!, normalized); collapsedCount += 1; }
    else deduped.push(normalized);
  }
  if (options?.maxItems !== undefined && options.maxItems >= 1) {
    while (deduped.length > options.maxItems && deduped.length >= 2) { coalesceBestPair(deduped); collapsedCount += 1; }
  }
  return { items: deduped, collapsedCount };
}

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
  const stripTailPunct = (s: string) => s.replace(/[.!?]+$/, "");
  const summary = stripTailPunct(stripTailPunct(spec.summary.trim().replace(/\s+/g, " ")).slice(0, 320));
  const when = stripTailPunct(stripTailPunct(spec.whenToUse.trim().replace(/^use\s+(?:this\s+skill\s+)?(?:when|for)\s+/i, "").replace(/\s+/g, " ")).slice(0, 280));
  const notFor = stripTailPunct(stripTailPunct(spec.whenNotToUse.trim().replace(/^(?:do\s+not\s+use(?:\s+for)?|not\s+for|skip:?)\s+/i, "").replace(/\s+/g, " ")).slice(0, 220));
  let desc = `${summary || spec.skillId}. Use when ${when || `working on ${spec.skillId}`}. Do not use for ${notFor || `tasks unrelated to ${spec.skillId}`}.`;
  if (desc.length < 50) desc = `${desc} Follow the golden skeleton and QA rubric.`;
  return desc.slice(0, 900);
}

function renderGoldenSkeleton(skillId: string, sections: readonly string[]): string {
  const effective = sections.length > 0 ? sections : ["Deliverable Overview"];
  const blocks = effective.map((raw, idx) => {
    const { clean, optionalCondition } = parseOptionalTag(stripRefLinks(raw));
    const cleanTitle = clean || "Deliverable Overview";
    const heading = optionalCondition
      ? `## ${idx + 1}. ${cleanTitle} [optional: when ${optionalCondition}]`
      : `## ${idx + 1}. ${cleanTitle}`;
    const body = optionalCondition
      ? `Optional section — include when ${optionalCondition}; omit cleanly otherwise. Provide concrete, verifiable content and structured details for ${cleanTitle}.`
      : `Provide concrete, verifiable content and structured details for ${cleanTitle}.`;
    return `${heading}\n\n${body}`;
  });
  return `# Golden Skeleton: ${skillId}\n\nMandatory ordered artifact structure. Sections marked [optional: when ...] apply only when that condition holds and may be omitted otherwise.\n\n${blocks.join("\n\n")}\n`;
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
  options?: { log?: (msg: string) => void },
): CompanionSkillCandidate {
  const isMerge = spec.mergeMode === "merge_core_and_overlay" && Boolean(existingFiles && existingFiles.length > 0);
  const existingMap = new Map((existingFiles ?? []).map((f) => [f.path, f.text]));
  const stripNum = (s: string) => s.replace(/^\d+\.\s*/, "");
  const stripBox = (s: string) => s.replace(/^-\s+\[[ xX]\]\s*/, "");

  const rawGolden = [...(isMerge ? extractMatches(existingMap.get("references/golden-skeleton.md"), /^##\s+(.+)$/gm, stripNum) : []), ...spec.goldenSkeletonSections.map(stripNum)].filter((s) => s.trim().length > 0);
  const compactedGolden = compactSemanticItems(rawGolden, { maxItems: MAX_GOLDEN_SKELETON_SECTIONS });
  const rawQa = [...(isMerge ? extractMatches(existingMap.get("references/qa-rubric.md"), /^-\s+\[[ xX]\]\s+(.+)$/gm) : []), ...spec.qaRubricChecks.map(stripBox)].filter((c) => c.trim().length > 0);
  const compactedQa = compactSemanticItems(rawQa);
  const rawRules = [...(isMerge ? extractBullets(existingMap.get("SKILL.md"), "Core Rules") : []), ...spec.coreRules].filter((r) => r.trim().length > 0);
  const compactedRules = compactSemanticItems(rawRules, { maxItems: MAX_CORE_RULES });

  const collapsedCount = compactedGolden.collapsedCount + compactedRules.collapsedCount;
  if (collapsedCount > 0) {
    options?.log?.(`DEBUG [nightGraphs.skillMerge] semantic_compacted ${redactKnown(JSON.stringify({
      skillId: spec.skillId, beforeSections: rawGolden.length, afterSections: compactedGolden.items.length,
      collapsedCount, beforeRules: rawRules.length, afterRules: compactedRules.items.length,
    }))}`);
  }

  const archetypeFiles = new Map<string, string>();
  if (isMerge) for (const [path, text] of existingMap) if (ARCHETYPE_FILE_RE.test(path)) archetypeFiles.set(path, text);
  for (const overlay of spec.archetypeOverlays) {
    const path = `references/archetype-${overlay.slug}.md`;
    if (ARCHETYPE_FILE_RE.test(path)) archetypeFiles.set(path, renderArchetypeOverlay(overlay, isMerge ? archetypeFiles.get(path) : undefined));
  }

  const archetypePaths = [...archetypeFiles.keys()].sort((a, b) => a.localeCompare(b));
  const files: SkillBundleFile[] = [
    { path: "SKILL.md", text: renderSkillMd(spec, compactedRules.items, archetypePaths) },
    { path: "references/golden-skeleton.md", text: renderGoldenSkeleton(spec.skillId, compactedGolden.items) },
    { path: "references/qa-rubric.md", text: renderQaRubric(spec.skillId, compactedQa.items) },
    ...archetypePaths.map((path) => ({ path, text: archetypeFiles.get(path)! })),
  ];
  return { skillId: spec.skillId, workflowIds: [...new Set(spec.workflowIds)], mergeMode: spec.mergeMode, files: sortSkillBundleFiles(files) };
}

function checkPreservedItems(
  prevItems: readonly string[],
  nextItems: readonly string[],
  code: "missing_golden_section" | "missing_qa_check",
  label: string,
  findings: NonDestructiveMergeFinding[],
): void {
  const nextClean = nextItems.map((item) => parseOptionalTag(item).clean);
  for (const prev of prevItems) {
    const prevClean = parseOptionalTag(prev).clean;
    const preserved = nextItems.some((next, idx) =>
      normWs(prev) === normWs(next) || isSameSkillTopic(prev, next) || nextClean[idx]!.split(";").some((c) => normHeading(c) === normHeading(prevClean)),
    );
    if (!preserved) findings.push({ code, detail: `${label} "${prev}" from existing skill was removed` });
  }
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
  const stripNum = (h: string) => h.replace(/^\d+\.\s*/, "");

  checkPreservedItems(
    extractMatches(prevMap.get("references/golden-skeleton.md"), /^##\s+(.+)$/gm, stripNum),
    extractMatches(nextMap.get("references/golden-skeleton.md"), /^##\s+(.+)$/gm, stripNum),
    "missing_golden_section", "Golden skeleton section", findings,
  );
  checkPreservedItems(
    extractMatches(prevMap.get("references/qa-rubric.md"), /^-\s+\[[ xX]\]\s+(.+)$/gm),
    extractMatches(nextMap.get("references/qa-rubric.md"), /^-\s+\[[ xX]\]\s+(.+)$/gm),
    "missing_qa_check", "QA rubric check", findings,
  );
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
