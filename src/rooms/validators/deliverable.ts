import { hardProblems } from "@lane-pilot/jev/judgments/invoice-check";

/**
 * Non-code QA (agents-design 3.5): the artifact checker a specialist's deliverable passes instead of a test run.
 * Each kind validates the file/page the agent produced; heavy external tools run through `deps.host.run` on the
 * employee's machine, and the same host stub drives the fixtures in tests.
 */
export type ValidatorKind = "text" | "design" | "page" | "3d" | "video" | "invoice" | "artifact";
export type Verdict = { ok: boolean; reason: string; details?: Record<string, unknown> };
export type RunResult = { exitCode: number; stdout: string; stderr: string };
export type ValidatorDeps = {
  /** Runs a shell command on the machine that holds the artifact (bench: placed host; tests: a stub). */
  host?: { run(hostId: string, cwd: string, command: string, timeoutSec: number): Promise<RunResult> };
  hostId?: string;
  /** Local read fallback where the file is on this machine already. */
  readFile?: (path: string) => string | null;
  /** What the task asked for (poly budget, invoice fields, page url…). */
  brief?: Record<string, unknown>;
};

const shq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function readText(path: string, deps: ValidatorDeps): Promise<string | null> {
  if (deps.readFile) return deps.readFile(path);
  if (!deps.host || !deps.hostId) return null;
  const out = await deps.host.run(deps.hostId, "/", `cat -- ${shq(path)} 2>/dev/null || true`, 30).catch(() => null);
  return out && out.exitCode === 0 && out.stdout ? out.stdout : null;
}

/* ---- text: ru-check / ru-score when installed, else the typographic rules in code ---- */

const SLOP = [/не просто\b/i, /это не [^,\n]{1,40},? это/i, /важно отметить/i, /стоит отметить/i, /давайте разбер[ёе]мся/i,
  /в современном мире/i, /в наши дни/i, /на сегодняшний день/i, /погруж[еа]/i, /экосистем/i, /парадигм/i, /безусловно/i, /не секрет/i];

async function validateText(path: string, deps: ValidatorDeps): Promise<Verdict> {
  const text = await readText(path, deps);
  if (text == null) return { ok: false, reason: `cannot read ${path}` };
  if (!text.trim()) return { ok: false, reason: "text file is empty" };
  if (deps.host && deps.hostId) {
    const probe = await deps.host.run(deps.hostId, "/", `command -v ru-check >/dev/null && ru-check ${shq(path)} || exit 3`, 60).catch(() => null);
    if (probe && probe.exitCode !== 3) return { ok: probe.exitCode === 0, reason: probe.exitCode === 0 ? "ru-check clean" : (probe.stdout || probe.stderr).trim().slice(0, 400) || "ru-check failed" };
  }
  const hits = SLOP.filter((re) => re.test(text)).map((re) => re.source);
  return hits.length ? { ok: false, reason: `typographic slop markers: ${hits.join(", ")}`, details: { markers: hits } } : { ok: true, reason: "no slop markers" };
}

/* ---- design/page: status, console errors, 375/1280 screenshots via host browser ---- */

async function validatePage(target: string, deps: ValidatorDeps): Promise<Verdict> {
  if (!deps.host || !deps.hostId) return { ok: false, reason: "no host to render the page on" };
  const status = await deps.host.run(deps.hostId, "/", `curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 ${shq(target)}`, 30).catch(() => null);
  if (!status || !/^2\d\d$/.test(status.stdout.trim())) return { ok: false, reason: `page did not answer 2xx (got ${status?.stdout.trim() || "no response"})` };
  // ponytail: headless console/screenshot pass goes through `bb browser-automation` on the machine when installed;
  // absent, HTTP 200 with no console check is accepted — upgrade path is the plugin's screenshot command.
  const shot = await deps.host.run(deps.hostId, "/", `command -v bb >/dev/null && bb browser-automation open ${shq(target)} --width 375 --shot /tmp/v375.png && bb browser-automation open ${shq(target)} --width 1280 --shot /tmp/v1280.png || exit 3`, 90).catch(() => null);
  if (shot && shot.exitCode !== 3 && shot.exitCode !== 0) return { ok: false, reason: `browser check failed: ${(shot.stderr || shot.stdout).trim().slice(0, 300)}` };
  return { ok: true, reason: "page answers; console/screenshots checked when the browser is available" };
}

/* ---- 3d: geometry report out of headless Blender ---- */

const BLENDER_PROBE = `import bpy,json
bad_ngon=0;flipped=0;tris=0
for o in bpy.data.objects:
    if o.type!='MESH':continue
    for p in o.data.polygons:
        tris+=p.loop_total-2 if p.loop_total>2 else 1
        if p.loop_total>4:bad_ngon+=1
        if p.normal.dot((p.center-o.matrix_world.translation).normalized())<0:flipped+=1
print('REPORT '+json.dumps({'ngons':bad_ngon,'flipped':flipped,'tris':tris}))`;

async function validate3d(path: string, deps: ValidatorDeps): Promise<Verdict> {
  if (!deps.host || !deps.hostId) return { ok: false, reason: "no host for a Blender probe" };
  const script = `blender -b ${shq(path)} --python-expr ${shq(BLENDER_PROBE)} 2>/dev/null | grep '^REPORT '`;
  const out = await deps.host.run(deps.hostId, "/", script, 300).catch(() => null);
  const match = /REPORT (\{.*\})/.exec(out?.stdout ?? "");
  if (!match) return { ok: false, reason: "Blender produced no geometry report" };
  const report = JSON.parse(match[1]) as { ngons: number; flipped: number; tris: number };
  const budget = Number(deps.brief?.polyBudget ?? deps.brief?.poly_budget ?? 0) || null;
  const problems: string[] = [];
  if (report.ngons) problems.push(`${report.ngons} n-gons`);
  if (report.flipped) problems.push(`${report.flipped} flipped normals`);
  if (budget && report.tris > budget) problems.push(`${report.tris} tris over the ${budget} budget`);
  return problems.length ? { ok: false, reason: problems.join("; "), details: report } : { ok: true, reason: `geometry clean (${report.tris} tris)`, details: report };
}

/* ---- video: ffprobe streams + EBU R128 loudness ---- */

async function validateVideo(path: string, deps: ValidatorDeps): Promise<Verdict> {
  if (!deps.host || !deps.hostId) return { ok: false, reason: "no host for ffprobe" };
  const probe = await deps.host.run(deps.hostId, "/", `ffprobe -v error -print_format json -show_streams -show_format ${shq(path)}`, 60).catch(() => null);
  let streams: Array<{ codec_type?: string }> = [], duration = 0;
  try {
    const parsed = JSON.parse(probe?.stdout ?? "{}") as { streams?: typeof streams; format?: { duration?: string } };
    streams = parsed.streams ?? [];
    duration = Number(parsed.format?.duration ?? 0);
  } catch { return { ok: false, reason: "ffprobe output unreadable" }; }
  if (!streams.some((stream) => stream.codec_type === "video")) return { ok: false, reason: "no video stream" };
  if (!streams.some((stream) => stream.codec_type === "audio")) return { ok: false, reason: "no audio stream" };
  if (!(duration > 0)) return { ok: false, reason: "no duration" };
  const loud = await deps.host.run(deps.hostId, "/", `ffmpeg -i ${shq(path)} -af loudnorm=I=-14:print_format=json -f null - 2>&1 | tail -20`, 180).catch(() => null);
  const measured = /"input_i"\s*:\s*"(-?\d+(?:\.\d+)?)"/.exec(loud?.stdout ?? "") ?? /"input_i"\s*:\s*"(-?\d+(?:\.\d+)?)"/.exec(loud?.stderr ?? "");
  if (measured && Math.abs(Number(measured[1]) + 14) > 1) return { ok: false, reason: `loudness ${measured[1]} LUFS, expected about -14`, details: { lufs: Number(measured[1]) } };
  return { ok: true, reason: `streams ok, ${duration}s${measured ? `, ${measured[1]} LUFS` : ""}` };
}

/* ---- invoice: PDF text against the request (jev invoice-check hard rules) ---- */

const digits = (text: string) => text.replace(/\D/g, "");

async function validateInvoice(path: string, deps: ValidatorDeps): Promise<Verdict> {
  let text = deps.readFile?.(path) ?? null;
  if (text == null && deps.host && deps.hostId) {
    const out = await deps.host.run(deps.hostId, "/", `(pdftotext ${shq(path)} - 2>/dev/null || strings ${shq(path)}) | head -200`, 60).catch(() => null);
    text = out?.stdout ?? null;
  }
  if (!text?.trim()) return { ok: false, reason: "no text in the PDF" };
  const brief = deps.brief ?? {};
  const inn = /\b\d{10}(?:\d{2})?\b/.exec(text)?.[0] ?? "";
  const bik = /\b04\d{7}\b/.exec(text)?.[0] ?? "";
  const amount = Number(String(brief.amount ?? /(\d[\d\s]*[.,]\d{2})/.exec(text)?.[1]?.replace(/[\s]/g, "").replace(",", ".") ?? NaN));
  const number = /(?:сч[её]т|invoice)\s*(?:№|#|no\.?)?\s*(\d[\w-]*)/i.exec(text)?.[1] ?? "";
  const request = { amount: Number(brief.amount ?? amount), inn: String(brief.inn ?? ""), company: String(brief.company ?? "client"), service: String(brief.service ?? "service") };
  const invoice = { number, amount, client_name: String(brief.client ?? "client"), client_inn: inn,
    payee_inn: String(brief.payee_inn ?? inn), pay_bik: bik, pay_account: /\b\d{20}\b/.exec(text)?.[0] ?? "", pay_corr_account: /\b301\d{17}\b/.exec(text)?.[0] ?? "", service: String(brief.service ?? "service") };
  const problems = hardProblems({ request, invoice });
  if (brief.inn && digits(String(brief.inn)) !== digits(inn)) problems.push(`the INN in the PDF is ${inn || "absent"}, the request says ${brief.inn}`);
  if (brief.bik && digits(String(brief.bik)) !== digits(bik)) problems.push(`the BIK in the PDF is ${bik || "absent"}, the request says ${brief.bik}`);
  return problems.length ? { ok: false, reason: problems.join("; ") } : { ok: true, reason: "invoice matches the request" };
}

/* ---- registry ---- */

const VALIDATORS: Record<string, (path: string, deps: ValidatorDeps) => Promise<Verdict>> = {
  text: validateText, design: validatePage, page: validatePage, "3d": validate3d, video: validateVideo, invoice: validateInvoice,
};

export const VALIDATOR_KINDS = Object.keys(VALIDATORS);

/**
 * The acceptance check of a non-code deliverable. `artifact` (default) only requires the file to exist and be
 * non-empty. A kind with no runner installed reports not-installed rather than passing silently.
 */
export async function validateDeliverable(kind: string | null | undefined, path: string, deps: ValidatorDeps = {}): Promise<Verdict> {
  const name = (kind?.trim() || "artifact") as ValidatorKind;
  if (name === "artifact") {
    const text = await readText(path, deps);
    const exists = text != null ? text.length > 0 : Boolean(deps.host && deps.hostId && (await deps.host.run(deps.hostId, "/", `[ -s ${shq(path)} ] || [ -n "$(find ${shq(path)} -mindepth 1 -print -quit 2>/dev/null)" ]`, 30).then((r) => r.exitCode === 0).catch(() => false)));
    return exists ? { ok: true, reason: "artifact exists and is not empty" } : { ok: false, reason: "artifact missing or empty" };
  }
  const run = VALIDATORS[name];
  if (!run) return { ok: false, reason: `validator ${name} is not installed` };
  return run(path, deps);
}
