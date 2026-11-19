import { bestEffort, isNotFound, sha256Hex } from "@lane-pilot/kit";
import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import type { ServerCore } from "../../contracts/server";
import type { CasFilesLike } from "../../storage";
import { noteEngineWrite } from "../../verification/server";
import bundledSkillsData from "../bundled-skills.json";
import {
  PILOT_AGENTS_END,
  PILOT_AGENTS_START,
  PILOT_ARCHITECTURE_REL_PATH,
  PILOT_CONFIG_REL_PATH,
  PILOT_DELEGATION_CONTEXT_REL_PATH,
  PILOT_DELEGATION_END,
  PILOT_DELEGATION_START,
  PILOT_DESCRIPTION_REL_PATH,
  PILOT_PLANS_DIR_REL_PATH,
  PILOT_RULES_BASE_REL_PATH,
  PILOT_SKILLS_DIR_REL_PATH,
  PILOT_STARTER_MARKER,
  mergePilotManagedBlock,
  parsePilotModelSpec,
  pilotAgentsContextBlock,
  pilotDelegationChoiceSchema,
  pilotDelegationContextBlock,
  pilotModelSpec,
  type PilotDelegationChoice,
} from "../index";

export interface BundledSkillBundle {
  name: string;
  skillMdSha256: string;
  treeSha256: string;
  files: Array<{ relPath: string; content: string; sha256: string }>;
}

export interface ProjectPlanSummary {
  path: string;
  title: string;
  tasks: Array<{ id: string; title: string; state: "todo" | "in_progress" | "done" | "failed" }>;
}

export interface WorkspacePilotInspection {
  configured: boolean;
  configError: string | null;
  delegation: PilotDelegationChoice;
  hasDescription: boolean;
  hasRulesBase: boolean;
  hasAgentsMd: boolean;
  hasArchitecture: boolean;
  files: Record<string, boolean>;
  gitBranch: string | null;
  gitDirty: boolean | null;
  skillStates: Array<{ name: string; state: "synced" | "outdated" | "missing" }>;
  plans: ProjectPlanSummary[];
}

let decodedBundles: BundledSkillBundle[] | null = null;

export function currentPluginVersion(): string {
  return bundledSkillsData.pluginVersion;
}

export function loadBundledPilotSkills(): BundledSkillBundle[] {
  if (!decodedBundles) {
    decodedBundles = bundledSkillsData.skills.map((skill) => ({
      name: skill.name,
      skillMdSha256: skill.skillMdSha256,
      treeSha256: skill.treeSha256,
      files: skill.files.map((f) => ({
        relPath: f.relPath,
        content: Buffer.from(f.contentBase64, "base64").toString("utf8"),
        sha256: f.sha256,
      })),
    }));
  }
  return decodedBundles;
}

function isMissingFileError(cause: unknown): boolean {
  if (isNotFound(cause)) return true;
  if (!cause || typeof cause !== "object") return false;
  const code = String((cause as { code?: unknown }).code ?? "");
  const msg = String((cause as { message?: unknown }).message ?? "");
  return code === "ENOENT" || /\bENOENT\b|not[ _-]?found|does not exist/i.test(msg);
}

export async function readRelText(
  filesApi: CasFilesLike,
  hostId: string,
  rootPath: string,
  relPath: string,
): Promise<{ exists: boolean; content: string; sha256: string | null }> {
  if (typeof filesApi?.read !== "function") return { exists: false, content: "", sha256: null };
  try {
    const cleanRel = relPath.replace(/^\/+/, "");
    const res = await filesApi.read({
      hostId,
      rootPath,
      path: `${rootPath.replace(/\/+$/, "")}/${cleanRel}`,
      maxBytes: 2_000_000,
    });
    if (!res || typeof res !== "object") return { exists: false, content: "", sha256: null };
    const rec = res as { content?: unknown; sha256?: unknown };
    if (typeof rec.content !== "string") return { exists: false, content: "", sha256: null };
    const sha256 =
      typeof rec.sha256 === "string" && /^[a-f0-9]{64}$/i.test(rec.sha256)
        ? rec.sha256.toLowerCase()
        : sha256Hex(rec.content);
    return { exists: true, content: rec.content, sha256 };
  } catch (cause) {
    if (isMissingFileError(cause)) return { exists: false, content: "", sha256: null };
    throw cause;
  }
}

export async function writeExactCas(
  filesApi: CasFilesLike,
  args: {
    hostId: string;
    rootPath: string;
    relPath: string;
    content: string;
    expectedSha256: string | null;
    ignoreCreateConflict?: boolean;
  },
): Promise<"written" | "skipped"> {
  const cleanRel = args.relPath.replace(/^\/+/, "");
  const fullPath = `${args.rootPath.replace(/\/+$/, "")}/${cleanRel}`;
  noteEngineWrite(args.rootPath, cleanRel);
  const res = await filesApi.write({
    hostId: args.hostId,
    rootPath: args.rootPath,
    path: fullPath,
    content: args.content,
    contentEncoding: "utf8",
    createParents: true,
    expectedSha256: args.expectedSha256,
  });
  if (!res || typeof res !== "object") return "written";
  if ("outcome" in res) {
    const outcome = (res as { outcome?: unknown }).outcome;
    if (outcome === "written") return "written";
    if (args.ignoreCreateConflict && args.expectedSha256 === null && (outcome === "conflict" || outcome === "sha_mismatch")) {
      return "skipped";
    }
    throw new Error(`CAS write refused for ${cleanRel}: ${String(outcome)}`);
  }
  const legacy = res as { ok?: unknown; error?: unknown };
  if (legacy.ok === false || (typeof legacy.error === "string" && legacy.error.trim().length > 0)) {
    throw new Error(`Write failed for ${cleanRel}: ${String(legacy.error ?? "unknown")}`);
  }
  return "written";
}

export function parseMarkdownPlan(relPath: string, content: string): ProjectPlanSummary {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? relPath.split("/").pop() ?? relPath;
  const tasks: ProjectPlanSummary["tasks"] = [];
  let idx = 0;
  let inFence = false;
  for (const line of content.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^\s*-\s*\[([ xX~!-])\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    idx += 1;
    const mark = m[1]!;
    const rawTitle = m[2]!.replace(/<!--[\s\S]*?-->/g, "").trim();
    const state =
      mark === "x" || mark === "X"
        ? "done"
        : mark === "~" || mark === "-"
          ? "in_progress"
          : mark === "!"
            ? "failed"
            : "todo";
    tasks.push({ id: `task-${idx}`, title: rawTitle, state });
  }
  return { path: relPath, title: heading, tasks };
}

function parseDelegationFromConfig(parsed: Record<string, unknown>): { choice: PilotDelegationChoice; error: string | null } {
  const raw = parsed.delegation;
  if (!raw) return { choice: { mode: "pilot-lanes" }, error: null };
  const direct = pilotDelegationChoiceSchema.safeParse(raw);
  if (direct.success) return { choice: direct.data, error: null };
  if (typeof raw === "object" && raw !== null && (raw as { mode?: unknown }).mode === "bb-subthreads") {
    const spec = parsePilotModelSpec((raw as { modelSpec?: unknown }).modelSpec);
    if (spec) return { choice: spec, error: null };
  }
  return { choice: { mode: "pilot-lanes" }, error: "Поле delegation в .agents/pilot/config.json имеет неизвестный формат." };
}

async function probeHostWorkspaceFacts(
  host: RunCommandHost | undefined,
  hostId: string,
  rootPath: string,
): Promise<{ files: Record<string, boolean>; gitBranch: string | null; gitDirty: boolean | null; planPaths: string[] }> {
  const empty = { files: {} as Record<string, boolean>, gitBranch: null, gitDirty: null, planPaths: [] as string[] };
  if (!host || typeof host.call !== "function") return empty;
  const script = [
    "branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)",
    "dirty=$(git status --porcelain 2>/dev/null | head -n 1 || true)",
    "printf 'BRANCH:%s\\n' \"$branch\"",
    "printf 'DIRTY:%s\\n' \"$([ -n \"$dirty\" ] && echo 1 || echo 0)\"",
    "for p in .husky lefthook.yml .lefthook.yml .pre-commit-config.yaml .gitlab-ci.yml .circleci/config.yml Jenkinsfile bitbucket-pipelines.yml; do",
    "  [ -e \"$p\" ] && printf 'FILE:%s\\n' \"$p\" || true",
    "done",
    "if ls .github/workflows/*.yml .github/workflows/*.yaml >/dev/null 2>&1; then printf 'FILE:.github/workflows/\\n'; fi",
    `if [ -d '${PILOT_PLANS_DIR_REL_PATH}' ]; then for f in '${PILOT_PLANS_DIR_REL_PATH}'/*.md; do [ -f "$f" ] && [ ! -L "$f" ] && printf 'PLAN:%s\\n' "$f" || true; done; fi`,
  ].join("\n");
  try {
    const ran = await runOnHost(host, { hostId, cwd: rootPath, command: script, timeoutSec: 15 });
    if (ran.exitCode !== 0) return empty;
    const files: Record<string, boolean> = {};
    const planPaths: string[] = [];
    let gitBranch: string | null = null;
    let gitDirty: boolean | null = null;
    for (const line of ran.stdout.split("\n")) {
      if (line.startsWith("BRANCH:")) gitBranch = line.slice(7).trim() || null;
      else if (line.startsWith("DIRTY:")) gitDirty = gitBranch ? line.slice(6).trim() === "1" : null;
      else if (line.startsWith("FILE:")) {
        const rel = line.slice(5).trim();
        if (rel) files[rel] = true;
      } else if (line.startsWith("PLAN:")) {
        const rel = line.slice(5).trim();
        if (rel) planPaths.push(rel);
      }
    }
    return { files, gitBranch, gitDirty, planPaths: planPaths.slice(0, 25) };
  } catch {
    return empty;
  }
}

const isFilledDoc = (file: { exists: boolean; content: string }) =>
  file.exists && file.content.trim().length > 40 && !file.content.includes(PILOT_STARTER_MARKER);

export async function inspectProjectPilotWorkspace(
  ctx: Pick<ServerCore, "bb" | "host">,
  input: { hostId: string; rootPath: string },
): Promise<WorkspacePilotInspection> {
  const filesApi = ctx.bb.sdk.files as unknown as CasFilesLike;
  const bundles = loadBundledPilotSkills();
  const [cfgFile, descFile, rulesFile, archFile, agentsFile, hostProbe, ...skillReads] = await Promise.all([
    readRelText(filesApi, input.hostId, input.rootPath, PILOT_CONFIG_REL_PATH),
    readRelText(filesApi, input.hostId, input.rootPath, PILOT_DESCRIPTION_REL_PATH),
    readRelText(filesApi, input.hostId, input.rootPath, PILOT_RULES_BASE_REL_PATH),
    readRelText(filesApi, input.hostId, input.rootPath, PILOT_ARCHITECTURE_REL_PATH),
    readRelText(filesApi, input.hostId, input.rootPath, "AGENTS.md"),
    probeHostWorkspaceFacts(ctx.host as unknown as RunCommandHost | undefined, input.hostId, input.rootPath),
    ...bundles.map((b) => readRelText(filesApi, input.hostId, input.rootPath, `${PILOT_SKILLS_DIR_REL_PATH}/${b.name}/SKILL.md`)),
  ]);

  let configured = false;
  let configError: string | null = null;
  let delegation: PilotDelegationChoice = { mode: "pilot-lanes" };
  let recordedSkillTrees: Record<string, string> = {};
  if (cfgFile.exists) {
    try {
      const parsed = JSON.parse(cfgFile.content) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        configError = ".agents/pilot/config.json должен быть JSON-объектом.";
      } else {
        configured = true;
        const del = parseDelegationFromConfig(parsed);
        delegation = del.choice;
        configError = del.error;
        if (parsed.installedSkills && typeof parsed.installedSkills === "object" && !Array.isArray(parsed.installedSkills)) {
          recordedSkillTrees = parsed.installedSkills as Record<string, string>;
        }
      }
    } catch (cause) {
      configError = `Ошибка чтения .agents/pilot/config.json: ${cause instanceof Error ? cause.message.slice(0, 140) : String(cause)}`;
    }
  }

  const skillStates = bundles.map((bundle, idx) => {
    const read = skillReads[idx]!;
    if (!read.exists) return { name: bundle.name, state: "missing" as const };
    const treeOk = !recordedSkillTrees[bundle.name] || recordedSkillTrees[bundle.name] === bundle.treeSha256;
    const mdOk = read.sha256 === bundle.skillMdSha256;
    return { name: bundle.name, state: mdOk && treeOk ? ("synced" as const) : ("outdated" as const) };
  });

  const planReads = await Promise.all(
    hostProbe.planPaths.map(async (relPath) => ({
      relPath,
      file: await readRelText(filesApi, input.hostId, input.rootPath, relPath),
    })),
  );
  const plans = planReads
    .filter((row) => row.file.exists)
    .map((row) => parseMarkdownPlan(row.relPath, row.file.content));

  return {
    configured,
    configError,
    delegation,
    hasDescription: isFilledDoc(descFile),
    hasRulesBase: isFilledDoc(rulesFile),
    hasAgentsMd: agentsFile.exists && agentsFile.content.trim().length > 0,
    hasArchitecture: isFilledDoc(archFile),
    files: hostProbe.files,
    gitBranch: hostProbe.gitBranch,
    gitDirty: hostProbe.gitDirty,
    skillStates,
    plans,
  };
}

function starterTemplates(projectName: string): Array<{ relPath: string; content: string }> {
  return [
    {
      relPath: PILOT_DESCRIPTION_REL_PATH,
      content: `${PILOT_STARTER_MARKER}\n# Описание проекта — ${projectName}\n\nЗапустите \`/lp-project-setup\` (или кнопку «Описать проект и правила» в правой панели Lane Pilot), чтобы заполнить стек, пакетный менеджер и проверенные команды \`typecheck\`, \`lint\`, \`test\`, \`build\`.\n`,
    },
    {
      relPath: PILOT_ARCHITECTURE_REL_PATH,
      content: `${PILOT_STARTER_MARKER}\n# Архитектура проекта — ${projectName}\n\nЗапустите \`/lp-project-setup\`, чтобы зафиксировать структуру каталогов, границы модулей и правила размещения новых файлов.\n`,
    },
    {
      relPath: PILOT_RULES_BASE_REL_PATH,
      content: `${PILOT_STARTER_MARKER}\n# Базовые конвенции кода — ${projectName}\n\nЗапустите \`/lp-project-setup\`, чтобы зафиксировать проверенные конвенции репозитория со ссылками \`file:line\`.\n`,
    },
  ];
}

export interface ProjectPilotBootstrapResult {
  installedSkills: string[];
  updatedSkills: string[];
  createdFiles: string[];
}

export async function materializeProjectPilotSetup(
  ctx: Pick<ServerCore, "bb" | "log">,
  input: {
    hostId: string;
    rootPath: string;
    projectName?: string | null;
    delegationOverride?: PilotDelegationChoice;
    onlyIfUnconfigured?: boolean;
    preserveExistingAgentsMd?: boolean;
  },
): Promise<ProjectPilotBootstrapResult> {
  const filesApi = ctx.bb.sdk.files as unknown as CasFilesLike;
  if (typeof filesApi?.write !== "function") {
    return { installedSkills: [], updatedSkills: [], createdFiles: [] };
  }
  const cfgFile = await readRelText(filesApi, input.hostId, input.rootPath, PILOT_CONFIG_REL_PATH);
  if (input.onlyIfUnconfigured && cfgFile.exists) {
    return { installedSkills: [], updatedSkills: [], createdFiles: [] };
  }
  let baseCfg: Record<string, unknown> = {};
  if (cfgFile.exists) {
    const parsed = JSON.parse(cfgFile.content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(".agents/pilot/config.json должен быть JSON-объектом.");
    }
    baseCfg = { ...(parsed as Record<string, unknown>) };
  }

  const bundles = loadBundledPilotSkills();
  const installedSkills: string[] = [];
  const updatedSkills: string[] = [];
  const createdFiles: string[] = [];

  for (const bundle of bundles) {
    const existingMd = await readRelText(filesApi, input.hostId, input.rootPath, `${PILOT_SKILLS_DIR_REL_PATH}/${bundle.name}/SKILL.md`);
    let touched = false;
    for (const file of bundle.files) {
      const targetRel = `${PILOT_SKILLS_DIR_REL_PATH}/${bundle.name}/${file.relPath}`;
      const current = await readRelText(filesApi, input.hostId, input.rootPath, targetRel);
      if (current.exists && current.sha256 === file.sha256) continue;
      await writeExactCas(filesApi, {
        hostId: input.hostId,
        rootPath: input.rootPath,
        relPath: targetRel,
        content: file.content,
        expectedSha256: current.exists ? current.sha256 : null,
      });
      touched = true;
    }
    if (touched) {
      if (!existingMd.exists) installedSkills.push(bundle.name);
      else updatedSkills.push(bundle.name);
    }
  }

  for (const starter of starterTemplates(input.projectName?.trim() || "Project")) {
    const existing = await readRelText(filesApi, input.hostId, input.rootPath, starter.relPath);
    if (!existing.exists) {
      const res = await writeExactCas(filesApi, {
        hostId: input.hostId,
        rootPath: input.rootPath,
        relPath: starter.relPath,
        content: starter.content,
        expectedSha256: null,
        ignoreCreateConflict: true,
      });
      if (res === "written") createdFiles.push(starter.relPath);
    }
  }

  const agentsFile = await readRelText(filesApi, input.hostId, input.rootPath, "AGENTS.md");
  if (!(input.preserveExistingAgentsMd && agentsFile.exists)) {
    const nextAgents = mergePilotManagedBlock(agentsFile.content, PILOT_AGENTS_START, PILOT_AGENTS_END, pilotAgentsContextBlock());
    if (nextAgents !== agentsFile.content) {
      await writeExactCas(filesApi, {
        hostId: input.hostId,
        rootPath: input.rootPath,
        relPath: "AGENTS.md",
        content: nextAgents,
        expectedSha256: agentsFile.exists ? agentsFile.sha256 : null,
      });
      if (!agentsFile.exists) createdFiles.push("AGENTS.md");
    }
  }

  const effectiveDelegation = input.delegationOverride ?? parseDelegationFromConfig(baseCfg).choice;
  const delegationForJson =
    effectiveDelegation.mode === "bb-subthreads"
      ? { ...effectiveDelegation, modelSpec: pilotModelSpec(effectiveDelegation), serviceTier: "default" }
      : effectiveDelegation;
  const installedSkillsMap = Object.fromEntries(bundles.map((b) => [b.name, b.treeSha256]));
  const prevLanguages =
    baseCfg.languages && typeof baseCfg.languages === "object" && !Array.isArray(baseCfg.languages)
      ? baseCfg.languages
      : { ui: "ru", artifacts: "ru", technicalTerms: "keep" };
  const comparableNext: Record<string, unknown> = {
    ...baseCfg,
    schemaVersion: 1,
    pilotVersion: currentPluginVersion(),
    languages: prevLanguages,
    delegation: delegationForJson,
    skillsDir: PILOT_SKILLS_DIR_REL_PATH,
    installedSkills: installedSkillsMap,
  };
  delete comparableNext.updatedAt;
  const comparableBase = { ...baseCfg };
  delete comparableBase.updatedAt;
  if (!cfgFile.exists || JSON.stringify(comparableBase) !== JSON.stringify(comparableNext)) {
    const nextConfig = {
      ...comparableNext,
      updatedAt: new Date().toISOString(),
    };
    await writeExactCas(filesApi, {
      hostId: input.hostId,
      rootPath: input.rootPath,
      relPath: PILOT_CONFIG_REL_PATH,
      content: `${JSON.stringify(nextConfig, null, 2)}\n`,
      expectedSha256: cfgFile.exists ? cfgFile.sha256 : null,
    });
    if (!cfgFile.exists) createdFiles.push(PILOT_CONFIG_REL_PATH);
  }

  const delFile = await readRelText(filesApi, input.hostId, input.rootPath, PILOT_DELEGATION_CONTEXT_REL_PATH);
  const delBlock = pilotDelegationContextBlock(effectiveDelegation);
  const nextDel = mergePilotManagedBlock(delFile.content, PILOT_DELEGATION_START, PILOT_DELEGATION_END, delBlock);
  if (nextDel !== delFile.content && (nextDel || delFile.exists)) {
    await writeExactCas(filesApi, {
      hostId: input.hostId,
      rootPath: input.rootPath,
      relPath: PILOT_DELEGATION_CONTEXT_REL_PATH,
      content: nextDel,
      expectedSha256: delFile.exists ? delFile.sha256 : null,
    });
    if (!delFile.exists) createdFiles.push(PILOT_DELEGATION_CONTEXT_REL_PATH);
  }

  await bestEffort(
    ctx.bb.log,
    "pilot project setup log",
    Promise.resolve(
      ctx.log(
        `Lane Pilot project setup synced at ${input.rootPath}: installed=${installedSkills.length}, updated=${updatedSkills.length}, created=${createdFiles.length}`,
      ),
    ),
    undefined,
  );
  return { installedSkills, updatedSkills, createdFiles };
}
