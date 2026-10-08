import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { slug as slugOf } from "../model";
import { SKIP_DIRS, type SourceRecord, type SourceScan } from "./common";

/**
 * The owner's clients and work from Kontur.Elba (A10), off until the owner switches the source on. It does not open Elba: the
 * `kontur-elba` skill keeps, for every deal, a `clients/<client>/terms.json` with the client, the contract and the invoice it made in
 * the cabinet; this reads those files (read only, no browser, no cabinet session, no network). A client becomes a person with the
 * relation `client` and the service as the statement; each invoice becomes an event (number and date). **No amount, INN, bank
 * detail or contract text is kept.** Everything here is `sensitive`: clients are, by the privacy rules (spec §6), and the invoices say who paid whom.
 */
const DAY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const MAX_DEPTH = 5;

const text = (value: unknown, max = 160): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Folders named `clients` under the roots, not entering the folders no source reads. */
export async function clientsFolders(roots: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name === "clients") found.add(path);
      else if (depth < MAX_DEPTH) await walk(path, depth + 1);
    }
  }
  for (const root of roots) await walk(root, 0);
  return [...found].sort();
}

const dayOf = (value: unknown): number | null => {
  const match = DAY_PREFIX.exec(text(value, 30));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : null;
};

export async function scanElba(roots: readonly string[]): Promise<SourceScan> {
  const records: SourceRecord[] = [];
  let items = 0;
  for (const folder of await clientsFolders(roots)) {
    let names: string[];
    try { names = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { continue; }
    for (const name of names) {
      const file = join(folder, name, "terms.json");
      let terms: Record<string, unknown>, mtime: number;
      try {
        terms = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        mtime = Math.floor((await stat(file)).mtimeMs);
      } catch { continue; }
      if (!terms || typeof terms !== "object" || Array.isArray(terms)) continue;
      // A deal that was never made in Elba is not Elba's evidence.
      if (terms.elba_created !== true) continue;
      const invoiceNumber = terms.invoice_number;
      const hasInvoice = typeof invoiceNumber === "number" || (typeof invoiceNumber === "string" && invoiceNumber.trim() !== "");
      const client = text(terms.client) || name;
      items += 1;
      const invoiceAt = dayOf(terms.invoice_date) ?? dayOf(terms.contract_updated_at) ?? mtime;
      const service = text(terms.contract_service_name, 300);
      const clientEvidence = { source: "elba" as const, ref: `elba:${slugOf(name)}`, at: invoiceAt };
      records.push({
        kind: "person", key: `elba-client:${slugOf(name)}`, title: client, statement: service ? `Client; service: ${service}` : "Client",
        attributes: { origin: "elba", relation: "client", ...(hasInvoice ? { invoices: 1 } : {}) }, sensitivity: "sensitive", confidence: 0.9,
        firstSeen: invoiceAt, lastSeen: invoiceAt, evidence: [clientEvidence],
      });
      if (hasInvoice) {
        records.push({
          kind: "event", key: `elba-invoice:${slugOf(name)}:${String(invoiceNumber)}`, title: `Invoice No ${String(invoiceNumber)} to ${client}`,
          statement: service ? `Invoice for: ${service}` : "", attributes: { origin: "elba", relation: "client" }, sensitivity: "sensitive", confidence: 0.9,
          firstSeen: invoiceAt, lastSeen: invoiceAt, evidence: [{ source: "elba" as const, ref: `elba:${slugOf(name)}/invoice-${String(invoiceNumber)}`, at: invoiceAt }],
        });
      }
    }
  }
  return { source: "elba", items, records, ...(items ? {} : { note: "no clients/<client>/terms.json found under the roots" }) };
}
