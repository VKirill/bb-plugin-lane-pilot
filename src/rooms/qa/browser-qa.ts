import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { currentHostId, spawnAsync, sha256Hex, orMiss, isFsAbsent } from "@lane-pilot/kit";
import { browserQaInputSchema, browserQaVerdict, type BrowserQaInput, type BrowserQaResult } from "./models/browser-qa";

export { browserQaInputSchema, browserQaVerdict, type BrowserQaInput, type BrowserQaResult } from "./models/browser-qa";

function sha256(data:Buffer|string):string {
  return sha256Hex(data);
}

function redact(text:string):string {
  return text
    .replace(/(\b(?:authorization|cookie|set-cookie|token|password|otp|api[_-]?key)\b\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
}

function hasPotentialSideEffect(cases:string[]):boolean {
  const english = /\b(submit|purchase|pay|delete|send|grant permission|revoke permission|create|update|save|publish|upload|download|change|confirm)\b/i;
  const russian = /удал|отправ|созда|оплат|куп|сохран|публику|подтверд|выда|отоз|измен|обнов|загруз|скача/i;
  return cases.some((item) => english.test(item) || russian.test(item));
}

async function collectArtifacts(root:string, dir:string, limit=100):Promise<Array<{path:string; sha256:string; size:number}>> {
  const rootReal = await realpath(root);
  const results:Array<{path:string; sha256:string; size:number}> = [];
  const visit = async (current:string):Promise<void> => {
    const entries = await readdir(current, { withFileTypes:true });
    for (const entry of entries) {
      if (results.length >= limit) return;
      const full = join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error("browser_qa_output_contains_symlink");
      if (info.isDirectory()) { await visit(full); continue; }
      if (!info.isFile()) continue;
      const real = await realpath(full);
      const rel = relative(rootReal, real);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("browser_qa_artifact_escaped_project");
      const bytes = await readFile(full);
      results.push({ path:rel.split("\\").join("/"), sha256:sha256(bytes), size:bytes.byteLength });
    }
  };
  await visit(dir);
  return results;
}

export async function runBrowserQaOnHost(raw:BrowserQaInput):Promise<BrowserQaResult> {
  const input = browserQaInputSchema.parse(raw);
  const target = new URL(input.url);
  if (!["http:","https:"].includes(target.protocol) || target.username || target.password) throw new Error("browser_qa_url_must_be_http_without_userinfo");
  const sideEffectCase = hasPotentialSideEffect(input.cases);
  if ((input.envClass === "production" || input.envClass === "unknown" || sideEffectCase) && !input.authorized) {
    throw new Error("browser_qa_requires_explicit_authorization_for_target_or_side_effect");
  }
  const project = await realpath(input.projectCwd);
  const agentsDir = join(project, ".agents");
  const qaDir = join(agentsDir, "qa");
  const outputDir = join(qaDir, input.slug);
  for (const path of [agentsDir, qaDir, outputDir]) {
    let info;
    try {
      info = await lstat(path);
    } catch (cause) {
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
    if (info.isSymbolicLink()) throw new Error("browser_qa_output_path_is_symlink");
    if (path === outputDir) throw new Error("browser_qa_slug_already_exists");
    if (!info.isDirectory()) throw new Error("browser_qa_output_parent_not_directory");
  }
  const runner = "browser-qa-codex";
  const binary = join(homedir(), ".agents", "bin", runner);
  if (!await orMiss(access(binary).then(() => true), false, isFsAbsent)) throw new Error(`browser_qa_runner_unavailable:${runner}`);
  const argv = ["--project-cwd", project, "--url", input.url, "--slug", input.slug,
    "--env-class", input.envClass, "--viewports", input.viewports, "--backend", input.backend];
  for (const item of input.cases) argv.push("--case", item);
  if (input.authorized) argv.push("--authorized");
  if (input.provider === "codex") {
    if (!input.model) throw new Error("browser_qa_codex_requires_configured_model");
    if (!input.reasoningEffort) throw new Error("browser_qa_codex_requires_supported_effort");
    argv.push("--model", input.model);
    argv.push("--reasoning-effort", input.reasoningEffort);
  }
  const completed = await spawnAsync(binary, argv, { cwd:project, timeout:input.timeoutSec * 1000, maxBuffer:4_000_000 });
  const exitCode = completed.status ?? 1;
  let artifacts:Array<{path:string; sha256:string; size:number}> = [];
  let reportText:string|null = null;
  let reportPath:string|null = null;
  let reportSha256:string|null = null;
  let actualModel:string|null = null;
  let actualReasoningEffort:string|null = null;
  let actualBackend:string|null = null;
  try {
    const rootReal = await realpath(project);
    const outputReal = await realpath(outputDir);
    const rel = relative(rootReal, outputReal);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("browser_qa_output_escaped_project");
    artifacts = await collectArtifacts(project, outputReal);
    const receiptName = "codex-run.json";
    const runnerReceipt = artifacts.find((item) => item.path === `.agents/qa/${input.slug}/${receiptName}`);
    if (runnerReceipt) {
      const rawReceipt:unknown = JSON.parse((await readFile(join(outputReal,receiptName))).toString("utf8"));
      if (rawReceipt && typeof rawReceipt === "object") {
        const record = rawReceipt as Record<string,unknown>;
        actualModel = typeof record.model === "string" ? record.model : null;
        actualReasoningEffort = typeof record.reasoning_effort === "string" ? record.reasoning_effort : null;
        actualBackend = typeof record.backend === "string" ? record.backend : null;
      }
    }
    const report = artifacts.find((item) => item.path === `.agents/qa/${input.slug}/REPORT.md`);
    if (report) {
      reportPath = report.path;
      reportSha256 = report.sha256;
      const reportBytes = await readFile(join(outputReal, "REPORT.md"));
      reportText = redact(reportBytes.toString("utf8").slice(0, 24_000));
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (exitCode === 0) return { hostId:currentHostId(input.requestedHostId), provider:input.provider, runner, exitCode,
      verdict:"blocked", actualModel, actualReasoningEffort, actualBackend, reportPath:null, reportSha256:null, reportText:null, artifacts, stdout:redact(completed.stdout ?? ""),
      stderr:redact(completed.stderr ?? ""), reason:message, processPid:completed.pid ?? null, runnerPath:binary };
  }
  return {
    hostId:currentHostId(input.requestedHostId), provider:input.provider, runner, exitCode,
    verdict:reportText ? browserQaVerdict(reportText, exitCode) : "blocked", actualModel, actualReasoningEffort, actualBackend, reportPath, reportSha256, reportText,
    artifacts, stdout:redact((completed.stdout ?? "").slice(0, 12_000)), stderr:redact((completed.stderr ?? "").slice(0, 12_000)),
    reason:reportText ? null : "browser_qa_report_missing",
    processPid:completed.pid ?? null, runnerPath:binary,
  };
}
