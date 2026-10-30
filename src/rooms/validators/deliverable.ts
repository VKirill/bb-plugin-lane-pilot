import { jev, type JevSettings } from "@lane-pilot/jev";
import { hardProblems } from "@lane-pilot/jev/judgments/invoice-check";
import { uiShotsJudgment } from "@lane-pilot/jev/judgments/ui-shots";
import { invoiceScanJudgment, type ScanField } from "@lane-pilot/jev/judgments/invoice-scan";

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
  /** Project/run Jev context (settings select off|shadow|active; receipts get the ids). Absent = registry defaults. */
  jevCtx?: { projectId?: string | null; runId?: string | null; settings?: JevSettings };
  /** Layer-3 visual review for pages (design tasks, or Jev/DOM uncertain). The caller wires design-lead / browser-qa. */
  review?: PageReview;
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

/* ---- design/page: three layers — DOM probe, Jev on screenshots, vision-agent review ---- */

/** Layer 1 (the gate): geometry facts from the live DOM, printed as `REPORT {json}` — horizontal scroll, elements past
 * the right edge, overlapping visible blocks, empty images. */
const DOM_PROBE_JS = `(()=>{const de=document.documentElement,W=window.innerWidth;
const off=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>4&&r.height>4&&r.left>W-1}).slice(0,5).map(e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:''));
const vis=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>40&&r.height>20&&r.bottom>0&&r.top<innerHeight&&getComputedStyle(e).visibility!=='hidden'&&e.children.length===0&&e.textContent.trim()}).map(e=>({e,r:e.getBoundingClientRect()}));
let overlaps=0;for(let i=0;i<vis.length;i++)for(let j=i+1;j<vis.length;j++){const a=vis[i].r,b=vis[j].r;if(a.left<b.right-8&&b.left<a.right-8&&a.top<b.bottom-8&&b.top<a.bottom-8)overlaps++}
const imgs=[...document.images].filter(i=>i.complete&&i.naturalWidth===0&&i.getBoundingClientRect().width>0).length;
return 'REPORT '+JSON.stringify({hscroll:de.scrollWidth>W+2,offRight:off,overlaps,brokenImgs:imgs,scrollW:de.scrollWidth,innerW:W})})()`;

export type DomReport = { hscroll: boolean; offRight: string[]; overlaps: number; brokenImgs: number; scrollW?: number; innerW?: number };

function domProblems(report: DomReport): string[] {
  const problems: string[] = [];
  if (report.hscroll) problems.push(`horizontal scroll (${report.scrollW ?? "?"}px > ${report.innerW ?? "?"}px viewport)`);
  if (report.offRight.length) problems.push(`elements past the right edge: ${report.offRight.join(", ")}`);
  if (report.overlaps) problems.push(`${report.overlaps} overlapping visible blocks`);
  if (report.brokenImgs) problems.push(`${report.brokenImgs} empty images`);
  return problems;
}

/** Layer 3 hook: a vision-capable agent (design-lead / browser-qa) reviews meaning and design. The caller supplies it. */
export type PageReview = (request: { url: string; brief: string; shots: string[]; dom: DomReport | null; jev: { verdict: string; worst: number; worstShot: string | null } | null }) => Promise<Verdict | null>;

async function validatePage(target: string, deps: ValidatorDeps): Promise<Verdict> {
  if (!deps.host || !deps.hostId) return { ok: false, reason: "no host to render the page on" };
  const status = await deps.host.run(deps.hostId, "/", `curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 ${shq(target)}`, 30).catch(() => null);
  if (!status || !/^2\d\d$/.test(status.stdout.trim())) return { ok: false, reason: `page did not answer 2xx (got ${status?.stdout.trim() || "no response"})` };
  const shot = await deps.host.run(deps.hostId, "/", `command -v bb >/dev/null && bb browser-automation open ${shq(target)} --width 375 --shot /tmp/v375.png && bb browser-automation open ${shq(target)} --width 1280 --shot /tmp/v1280.png || exit 3`, 90).catch(() => null);
  if (shot && shot.exitCode !== 3 && shot.exitCode !== 0) return { ok: false, reason: `browser check failed: ${(shot.stderr || shot.stdout).trim().slice(0, 300)}` };
  const probe = shot && shot.exitCode === 0 ? await deps.host.run(deps.hostId, "/", `bb browser-automation run --script ${shq(DOM_PROBE_JS)} 2>/dev/null | grep -o 'REPORT {.*}' | head -1 || exit 3`, 60).catch(() => null) : null;
  const match = /REPORT (\{.*\})/.exec(probe?.stdout ?? "");
  const dom = match ? JSON.parse(match[1]) as DomReport : null;
  const problems = dom ? domProblems(dom) : [];
  if (problems.length) return { ok: false, reason: `DOM check: ${problems.join("; ")}`, details: { dom } };
  return judgeScreenshots(target, deps, dom);
}

/** Layer 2: Jev on the screenshots (cut-off only — the live probe showed it misses semantic breakage). Layer 3: deps.review. */
async function judgeScreenshots(target: string, deps: ValidatorDeps, dom: DomReport | null): Promise<Verdict> {
  const brief = String(deps.brief?.objective ?? deps.brief?.page ?? "");
  const base = { ok: true, reason: "page answers; DOM clean when the probe ran" };
  const judge = jev();
  let jevSeen: { verdict: string; worst: number; worstShot: string | null; box?: unknown } | null = null;
  if (judge && deps.host && deps.hostId) {
    const shots = await Promise.all(["v375", "v1280"].map(async (name) => {
      const out = await deps.host!.run(deps.hostId!, "/", `base64 < /tmp/${name}.png 2>/dev/null | tr -d '\n'`, 60).catch(() => null);
      const data = out?.stdout?.trim();
      return data && out!.exitCode === 0 ? { name: `${name}px`, format: "png" as const, data_base64: data.slice(0, 6_000_000) } : null;
    }));
    const valid = shots.filter((shot) => shot !== null);
    if (valid.length) {
      const verdict = await judge.judge(uiShotsJudgment, { url: target, shots: valid }, deps.jevCtx ?? {}).catch(() => null);
      if (verdict?.by === "jev") {
        jevSeen = verdict.decision;
        if (verdict.decision.verdict === "cut") {
          const hint = verdict.decision.box ? `, area [${(Object.values(verdict.decision.box) as number[]).map((v) => v.toFixed(2)).join(",")}]` : "";
          return { ok: false, reason: `content cut off on ${verdict.decision.worstShot} (jev p=${verdict.decision.worst})${hint}`, details: { dom, jev: verdict.decision } };
        }
      } else if (verdict?.by === "fallback" && verdict.shadow?.decision) {
        jevSeen = verdict.shadow.decision as unknown as typeof jevSeen;
      }
    }
  }
  const wantsReview = deps.review && (jevSeen?.verdict === "uncertain" || Boolean(deps.brief?.design));
  if (wantsReview) {
    const reviewed = await deps.review!({ url: target, brief, shots: ["/tmp/v375.png", "/tmp/v1280.png"], dom, jev: jevSeen }).catch(() => null);
    if (reviewed) return { ...reviewed, details: { dom, jev: jevSeen } };
    return { ...base, reason: `${base.reason}; visual review unavailable${jevSeen ? `, jev: ${jevSeen.verdict} ${jevSeen.worst}` : ""}`, details: { dom, jev: jevSeen } };
  }
  return { ...base, details: { dom, jev: jevSeen } };
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
  if (!text?.trim()) return judgeInvoiceScan(path, deps);
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

/** B4: a scan without a text layer goes to Jev — expected field values are checked on the page image, not OCR'd free-hand. */
async function judgeInvoiceScan(path: string, deps: ValidatorDeps): Promise<Verdict> {
  const judge = jev();
  if (!judge || !deps.host || !deps.hostId) return { ok: false, reason: "no text in the PDF" };
  const brief = deps.brief ?? {};
  const expected = Object.fromEntries((["inn", "bik", "amount", "number"] as ScanField[]).filter((f) => brief[f] != null && String(brief[f]).trim() !== "").map((f) => [f, String(brief[f])]));
  if (!Object.keys(expected).length) return { ok: false, reason: "no text in the PDF and no expected fields in the brief" };
  const shot = await deps.host.run(deps.hostId, "/", `(pdftoppm -f 1 -singlefile -png -r 150 ${shq(path)} /tmp/invoice-scan 2>/dev/null || magick -density 150 ${shq(`${path}[0]`)} /tmp/invoice-scan.png 2>/dev/null) && base64 < /tmp/invoice-scan.png | tr -d '\n'`, 120).catch(() => null);
  const data = shot?.stdout?.trim();
  if (!data || shot!.exitCode !== 0) return { ok: false, reason: "no text in the PDF and the page could not be rendered" };
  const verdict = await judge.judge(invoiceScanJudgment, { expected, page: { format: "png", data_base64: data.slice(0, 9_000_000) } }, deps.jevCtx ?? {}).catch(() => null);
  if (!verdict) return { ok: false, reason: "no text in the PDF" };
  if (verdict.by === "jev") {
    const d = verdict.decision;
    return d.ok
      ? { ok: true, reason: `scan fields match the request (${Object.entries(d.fields).map(([f, p]) => `${f} p=${p}`).join(", ")})`, details: { jev: d } }
      : { ok: false, reason: `scan fields off: ${d.failed.join(", ")}`, details: { jev: d } };
  }
  const shadow = verdict.by === "fallback" && verdict.shadow?.decision ? `; jev shadow: ${invoiceScanJudgment.describe(verdict.shadow.decision)}` : "";
  return { ok: false, reason: `no text in the PDF${shadow}`, details: { jevAsked: true } };
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
