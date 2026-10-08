import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { checkInvoicePdf } from "../../src/rooms/workflow/server/invoice-pdf";

// Audit 2026-10-08 round 4, item 20: the PDF path came from the same agent's report and the PDF was never opened. The check runs on the
// machine with the file; here the fake machine runs the real command in a shell.
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const host = (calls: string[] = []) => ({
  call: async (method: string, input: { command: string }) => {
    calls.push(method);
    const { stdout } = await exec("sh", ["-c", input.command]);
    return { hostId: "mini", exitCode: 0, stdout, stderr: "" };
  },
});
const PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
async function file(name: string, content: string | Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "lp-pdf-"));
  dirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe("the PDF of an invoice is opened by code on the machine that has it", () => {
  it("passes a whole PDF and reports its size and pages", async () => {
    const path = await file("invoice-142.pdf", PDF);
    expect(await checkInvoicePdf(host() as never, "mini", path)).toEqual({ ok: true, problems: [], size: PDF.length, pages: 1 });
  });

  it("fails a missing file, an empty file, a file that is not a PDF, a cut one and a name that is not .pdf", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-pdf-"));
    dirs.push(dir);
    const problems = async (path: string) => (await checkInvoicePdf(host() as never, "mini", path)).problems.join(" | ");
    expect(await problems(join(dir, "nope.pdf"))).toMatch(/does not exist/);
    expect(await problems(await file("empty.pdf", ""))).toMatch(/empty/);
    expect(await problems(await file("html.pdf", "<html>Elba login</html>"))).toMatch(/not a PDF/);
    expect(await problems(await file("cut.pdf", PDF.slice(0, PDF.indexOf("trailer"))))).toMatch(/cut|end marker/);
    expect(await problems(await file("report.txt", PDF))).toMatch(/\.pdf/);
    expect(await problems("relative/invoice.pdf")).toMatch(/absolute/);
    expect(await problems("")).toMatch(/no path/);
  });

  it("fails a PDF with no page in a file that has no compressed object streams", async () => {
    const result = await checkInvoicePdf(host() as never, "mini", await file("nopage.pdf", "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n"));
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/no page/);
  });

  it("does not guess pages in a PDF whose objects are compressed", async () => {
    const result = await checkInvoicePdf(host() as never, "mini", await file("packed.pdf", "%PDF-1.5\n4 0 obj\n<< /Type /ObjStm /N 3 >>\nstream\nxx\nendstream\nendobj\ntrailer\n%%EOF\n"));
    expect(result).toMatchObject({ ok: true, pages: null });
  });

  it("a path with quotes and spaces is passed as data, not as shell", async () => {
    const path = await file("it's $(touch pwned) a invoice.pdf", PDF);
    expect((await checkInvoicePdf(host() as never, "mini", path)).ok).toBe(true);
  });

  it("a machine that cannot be asked is a failed check, not a pass", async () => {
    const down = { call: async () => { throw new Error("host unreachable"); } };
    const result = await checkInvoicePdf(down as never, "mini", "/x/invoice.pdf");
    expect(result).toMatchObject({ ok: false, unreachable: true });
    expect(result.problems.join(" ")).toMatch(/could not be checked.*host unreachable/);
    expect(await checkInvoicePdf(down as never, "", "/x/invoice.pdf")).toMatchObject({ ok: false, unreachable: true });
  });
});
