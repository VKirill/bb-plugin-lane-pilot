import type { ServerCore } from "./core";
import { runOnHost } from "@lane-pilot/host-calls";

/**
 * The PDF of an invoice, opened by code (audit 2026-10-08 round 4, item 20): the path comes from the report of the agent that made the
 * invoice, and the file used to be sent to Telegram without anyone having looked at it. The check runs on the machine that has the file
 * (`runCommand`, plain POSIX tools): the file exists, is not empty, starts with `%PDF-`, ends with `%%EOF` (not cut), and has a page
 * object. A PDF whose objects are packed (`/ObjStm`) hides its pages from a text search, so then the page count is unknown, not zero.
 * It does not read the text of the invoice: the number and the amount are compared in the node from what the Elba step read.
 */
export type PdfCheck = { ok: boolean; problems: string[]; size?: number; pages?: number | null; unreachable?: boolean };

/** `'it'\''s'`: a path goes into the command as one shell word, whatever it contains. */
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

const PROBE = (path: string) => [
  `f=${quote(path)};`,
  `if [ ! -f "$f" ]; then echo exists=0; else echo exists=1;`,
  `echo size=$(wc -c < "$f" | tr -d ' ');`,
  `echo magic=$(head -c 5 "$f" | od -An -tx1 | tr -d ' \\n');`,
  `echo eof=$(tail -c 1024 "$f" | grep -a -c '%%EOF');`,
  `echo pages=$(grep -a -c '/Type[[:space:]]*/Page[^s]' "$f");`,
  `echo packed=$(grep -a -c '/ObjStm' "$f"); fi`,
].join(" ");

export async function checkInvoicePdf(host: Pick<ServerCore["host"], "call">, hostId: string, path: string): Promise<PdfCheck> {
  const problems: string[] = [];
  const shown = path.slice(0, 200);
  if (!path.trim()) return { ok: false, problems: ["the invoice has no path to its PDF"] };
  if (!path.startsWith("/")) problems.push(`the PDF path "${shown}" is not absolute`);
  if (!/\.pdf$/i.test(path)) problems.push(`the PDF path "${shown}" does not end in .pdf`);
  if (/[\0\n\r]/.test(path)) problems.push("the PDF path has a control character");
  if (problems.length) return { ok: false, problems };
  if (!hostId) return { ok: false, unreachable: true, problems: ["the PDF could not be checked: no machine is named for the file"] };
  let stdout: string;
  try {
    const ran = await runOnHost(host, { hostId, cwd: "/", command: PROBE(path), timeoutSec: 20 }) as { exitCode?: number; stdout?: string };
    if (ran.exitCode !== 0) throw new Error(`exit code ${String(ran.exitCode)}`);
    stdout = String(ran.stdout ?? "");
  } catch (cause) {
    return { ok: false, unreachable: true, problems: [`the PDF could not be checked: ${(cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").slice(0, 200)}`] };
  }
  const fact = (key: string): string => new RegExp(`^${key}=(.*)$`, "m").exec(stdout)?.[1]?.trim() ?? "";
  if (fact("exists") !== "1") return { ok: false, problems: [`the PDF "${shown}" does not exist on the machine`] };
  const size = Number(fact("size"));
  if (!Number.isFinite(size) || size <= 0) return { ok: false, size: 0, problems: [`the PDF "${shown}" is empty`] };
  if (fact("magic") !== "255044462d") problems.push(`the file "${shown}" is not a PDF (it does not start with %PDF-)`);
  else {
    if (Number(fact("eof")) < 1) problems.push("the PDF has no end marker (%%EOF): the file is cut");
    const pages = Number(fact("pages"));
    if (pages < 1 && Number(fact("packed")) < 1) problems.push("the PDF has no page");
    if (!problems.length) return { ok: true, problems: [], size, pages: pages >= 1 ? pages : null };
  }
  return { ok: false, size, problems };
}
