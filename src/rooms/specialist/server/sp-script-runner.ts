import { execPluginPythonAsync, hasPluginScript } from "../plugin-python";

export { mapScriptOutputToDeclaredFields } from "./sp-script-aliases";

const SAFE_SKILL = /^[a-z][a-z0-9-]{1,47}$/;
const SAFE_SCRIPT = /^[a-z0-9_]{1,64}\.py$/;

export interface ScriptRunRequest {
  skill: string;
  script: string;
  args: Record<string, unknown>;
  timeoutSec: number;
  mode?: "sim" | "live";
  allowFixtureFallback?: boolean;
  checkoutFiles?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ScriptRunResult {
  raw: Record<string, unknown>;
  usedFixtureFallback: boolean;
  exitCode: number;
}

function tryParsePreReadJson(checkoutFiles: Record<string, string> | undefined, relOrAbs: unknown): unknown {
  if (!checkoutFiles || typeof relOrAbs !== "string" || !relOrAbs.trim()) return undefined;
  const clean = relOrAbs.trim();
  const raw = checkoutFiles[clean] ?? checkoutFiles[clean.replace(/^\/+/, "")];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function hydrateScriptInput(script: string, args: Record<string, unknown>, checkoutFiles?: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...args };
  const adsLoaded = tryParsePreReadJson(checkoutFiles, args.ads);
  if (adsLoaded !== undefined) {
    payload.ads = Array.isArray(adsLoaded)
      ? adsLoaded
      : typeof adsLoaded === "object" && adsLoaded && Array.isArray((adsLoaded as { ads?: unknown[] }).ads)
        ? (adsLoaded as { ads: unknown[] }).ads
        : adsLoaded;
  }
  const clustersLoaded = tryParsePreReadJson(checkoutFiles, args.clusters ?? args.paid);
  if (clustersLoaded !== undefined) {
    if (Array.isArray(clustersLoaded)) payload.queries = clustersLoaded;
    else if (typeof clustersLoaded === "object" && clustersLoaded) Object.assign(payload, clustersLoaded);
  }
  const organicLoaded = tryParsePreReadJson(checkoutFiles, args.organic);
  if (organicLoaded !== undefined && Array.isArray(organicLoaded)) {
    payload.organic = organicLoaded;
  }
  const invLoaded = tryParsePreReadJson(checkoutFiles, args.inventory);
  if (invLoaded !== undefined && typeof invLoaded === "object" && invLoaded) {
    Object.assign(payload, invLoaded);
  }
  if (script === "curriculum_lint.py" && checkoutFiles) {
    const documents: Array<{ name: string; text: string }> = [];
    for (const k of ["atoms", "questions", "dir", "file"]) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) {
        const key = v.trim();
        const text = checkoutFiles[key] ?? checkoutFiles[key.replace(/^\/+/, "")];
        if (text !== undefined) documents.push({ name: key, text });
      }
    }
    if (documents.length > 0) payload.documents = documents;
  }
  if (script === "replay_scorer.py" && !payload.runs) {
    const ansList = Array.isArray(args.answers) ? args.answers : args.answers ? [args.answers] : [];
    for (const cand of ansList) {
      const loaded = tryParsePreReadJson(checkoutFiles, cand);
      if (Array.isArray(loaded)) {
        payload.runs = loaded;
        break;
      }
      if (loaded && typeof loaded === "object" && Array.isArray((loaded as { runs?: unknown[] }).runs)) {
        payload.runs = (loaded as { runs: unknown[] }).runs;
        break;
      }
    }
  }
  if (script === "release_graph_sim.py" && (!payload.before || !payload.after)) {
    const redirLoaded = tryParsePreReadJson(checkoutFiles, args.redirects);
    if (redirLoaded && typeof redirLoaded === "object" && "before" in redirLoaded && "after" in redirLoaded) {
      Object.assign(payload, redirLoaded);
    }
  }
  if (script === "passport_grill_engine.py") {
    const rawPassportArg = args.passport ?? args.passport_json;
    const passportLoaded = tryParsePreReadJson(checkoutFiles, rawPassportArg);
    if (passportLoaded && typeof passportLoaded === "object") {
      payload.passport = passportLoaded;
    } else if (typeof rawPassportArg === "string" && rawPassportArg.trim().startsWith("{")) {
      try {
        payload.passport = JSON.parse(rawPassportArg) as unknown;
      } catch {
        // leave as-is for degraded error or sim fixture fallback
      }
    }
  }
  return payload;
}

/** Runs a verified Python script from `<pluginRoot>/skills/<skill>/scripts/<script>` and parses its JSON output. */
export async function runVerifiedSkillScript(req: ScriptRunRequest): Promise<ScriptRunResult> {
  if (!SAFE_SKILL.test(req.skill)) throw new Error(`sp.run_script: invalid skill name "${req.skill}"`);
  if (!SAFE_SCRIPT.test(req.script)) throw new Error(`sp.run_script: invalid script name "${req.script}"`);

  if (!hasPluginScript(req.skill, req.script)) {
    throw new Error(`sp.run_script: script not found at skills/${req.skill}/scripts/${req.script}`);
  }

  const timeoutMs = Math.max(5_000, Math.min(300_000, req.timeoutSec * 1_000));
  const hydrated = hydrateScriptInput(req.script, req.args, req.checkoutFiles);
  const firstTry = await execPluginPythonAsync(req.skill, req.script, ["--input", "-"], JSON.stringify(hydrated), timeoutMs, req.env);

  if (firstTry.exitCode === 0 && firstTry.stdout.trim()) {
    try {
      const parsed = JSON.parse(firstTry.stdout) as Record<string, unknown>;
      if (parsed.ok === true) {
        return { raw: parsed, usedFixtureFallback: false, exitCode: 0 };
      }
    } catch {
      // Non-JSON stdout falls through to live degraded error or explicit fixture fallback below.
    }
  }

  const allowFixture = req.mode === "sim" || req.args.allow_fixture === true || req.allowFixtureFallback === true;
  if (!allowFixture) {
    const errText = (firstTry.stderr || firstTry.stdout || `exit_code_${firstTry.exitCode}`).trim().slice(0, 300);
    return {
      raw: {
        ok: false,
        degraded_error: true,
        blind: true,
        verdict: "degraded_error",
        alerts: [],
        skipped: [req.script],
        error: errText,
      },
      usedFixtureFallback: false,
      exitCode: firstTry.exitCode || 1,
    };
  }

  // Only in simulation mode or explicit fixture-enabled harnesses: run `--fixture` so deterministic script math executes.
  const fixtureRun = await execPluginPythonAsync(req.skill, req.script, ["--fixture"], undefined, timeoutMs, req.env);
  if (fixtureRun.exitCode !== 0 || !fixtureRun.stdout.trim()) {
    throw new Error(
      `sp.run_script (${req.skill}/${req.script}) failed: ${(firstTry.stderr || firstTry.stdout || fixtureRun.stderr).trim().slice(0, 300)}`,
    );
  }
  const fxParsed = JSON.parse(fixtureRun.stdout) as Record<string, unknown>;
  return {
    raw: { ...fxParsed, _input_args: req.args },
    usedFixtureFallback: true,
    exitCode: 0,
  };
}
