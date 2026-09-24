import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export const LANE_PILOT_READ_NAME = "lane_pilot_read";
export const LANE_PILOT_READ_SCHEMA_VERSION = 1 as const;
export const BOUNDED_READ_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const BOUNDED_READ_MAX_SLICE_BYTES = 256 * 1024;

export type BoundedReadResult = {
  schemaVersion: typeof LANE_PILOT_READ_SCHEMA_VERSION;
  hostId: string;
  path: string;
  content: string;
  contentEncoding: "utf8";
  sha256: string;
  sizeBytes: number;
  totalLines: number;
  offset: number;
  maxLines: number;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
  returnedBytes: number;
};

export async function readBoundedWorkspaceFile(input: {
  hostId: string;
  projectCwd: string;
  relativePath: string;
  offset: number;
  maxLines: number;
}): Promise<BoundedReadResult> {
  const rootInfo = await lstat(input.projectCwd);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("writer workspace root must be a real directory");
  }
  const rootReal = await realpath(input.projectCwd);
  const normalized = input.relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    isAbsolute(input.relativePath)
    || input.relativePath.includes("\0")
    || input.relativePath.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.length > 1024
  ) {
    throw new Error("lane_pilot_read_path_escaped_workspace");
  }
  const fullPath = join(rootReal, normalized);
  let cursor = rootReal;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error("lane_pilot_read_path_cannot_traverse_symlink");
    if (cursor !== fullPath && !info.isDirectory()) throw new Error("lane_pilot_read_parent_must_be_directory");
    if (cursor === fullPath && !info.isFile()) throw new Error("lane_pilot_read_target_must_be_regular_file");
  }
  const actual = await realpath(fullPath);
  const rel = relative(rootReal, actual);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("lane_pilot_read_path_escaped_workspace");
  const info = await lstat(actual);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("lane_pilot_read_target_must_be_regular_file");
  if (info.size > BOUNDED_READ_MAX_FILE_BYTES) {
    throw new Error(`lane_pilot_read_file_exceeds_${BOUNDED_READ_MAX_FILE_BYTES}_bytes`);
  }

  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let carry = "";
  let endedWithNewline = false;
  let scannedBytes = 0;
  let totalLines = 0;
  const selected: string[] = [];
  let sliceBytes = 0;
  let truncated = false;
  let collecting = true;

  const acceptLine = (line: string) => {
    const idx = totalLines;
    totalLines += 1;
    if (!collecting) return;
    if (idx < input.offset) return;
    if (idx >= input.offset + input.maxLines) {
      truncated = true;
      collecting = false;
      return;
    }
    const extra = selected.length === 0
      ? Buffer.byteLength(line, "utf8")
      : Buffer.byteLength(`\n${line}`, "utf8");
    if (sliceBytes + extra > BOUNDED_READ_MAX_SLICE_BYTES) {
      truncated = true;
      collecting = false;
      return;
    }
    selected.push(line);
    sliceBytes += extra;
  };

  try {
    for await (const chunk of createReadStream(actual, { highWaterMark: 64 * 1024 })) {
      const bytes = chunk as Buffer;
      scannedBytes += bytes.byteLength;
      if (scannedBytes > BOUNDED_READ_MAX_FILE_BYTES) {
        throw new Error(`lane_pilot_read_file_exceeds_${BOUNDED_READ_MAX_FILE_BYTES}_bytes`);
      }
      if (bytes.includes(0)) throw new Error("lane_pilot_read_binary_rejected");
      hash.update(bytes);
      endedWithNewline = bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0a;
      carry += decoder.decode(bytes, { stream: true });
      let nl = carry.indexOf("\n");
      while (nl >= 0) {
        acceptLine(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
        nl = carry.indexOf("\n");
      }
    }
    carry += decoder.decode();
  } catch (cause) {
    if (cause instanceof TypeError) throw new Error("lane_pilot_read_not_valid_utf8");
    throw cause;
  }

  if (carry.length > 0) acceptLine(carry);
  else if (endedWithNewline && scannedBytes > 0) acceptLine("");

  const content = selected.join("\n");
  const returnedBytes = Buffer.byteLength(content, "utf8");
  return {
    schemaVersion: LANE_PILOT_READ_SCHEMA_VERSION,
    hostId: input.hostId,
    path: rel.split("\\").join("/"),
    content,
    contentEncoding: "utf8",
    sha256: hash.digest("hex"),
    sizeBytes: scannedBytes,
    totalLines,
    offset: input.offset,
    maxLines: input.maxLines,
    lineStart: input.offset + 1,
    lineEnd: selected.length === 0 ? input.offset : input.offset + selected.length,
    truncated: truncated || input.offset + selected.length < totalLines,
    returnedBytes,
  };
}
