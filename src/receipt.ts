import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_OPS_WARNING } from "./constants";

export type FileChange = {
  path: string;
  sha256Before: string | null;
  sha256After: string | null;
};

export type InstallReceipt = {
  schemaVersion: 1;
  action: string;
  scenario: string | null;
  filesChanged: FileChange[];
  externalOpsBefore: Record<string, string | null>;
  externalOpsAfter: Record<string, string | null>;
  skippedExternalOps: string[];
  warning: string | null;
  exitCode: number;
  receiptPath: string | null;
  snapshotPath: string | null;
  sourceSha: string | null;
  notes: string[];
};

export async function writeReceipt(
  receipt: Omit<InstallReceipt, "receiptPath" | "schemaVersion"> & { receiptPath?: string | null },
  receiptDir: string | null,
): Promise<InstallReceipt> {
  const ts = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  let receiptPath: string | null = receipt.receiptPath ?? null;
  if (receiptDir) {
    await mkdir(receiptDir, { recursive: true });
    receiptPath = join(receiptDir, `lane-pilot-install-${receipt.action}-${ts}.json`);
  }
  const full: InstallReceipt = { ...receipt, schemaVersion: 1, receiptPath };
  if (receiptPath) await writeFile(receiptPath, `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

export function skippedOpsReceipt(skipped: string[]): Pick<
  InstallReceipt,
  "skippedExternalOps" | "warning"
> {
  return {
    skippedExternalOps: skipped,
    warning: skipped.length > 0 ? EXTERNAL_OPS_WARNING : null,
  };
}
