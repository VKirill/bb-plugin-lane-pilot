import {
  BOUNDED_READ_MAX_FILE_BYTES,
  BOUNDED_READ_MAX_SLICE_BYTES,
  LANE_PILOT_READ_SCHEMA_VERSION,
  sha256Hex,
  type BoundedReadResult,
} from "@lane-pilot/kit";

/**
 * Test-side mirror of the shipped host primitive `readBoundedWorkspaceFile`
 * (packages/kit/src/bounded-read.ts) for fixtures whose workspace is virtual:
 * same LF-only line split (a trailing "\n" yields a final empty line, "" yields
 * zero lines, "\r" is kept), same offset/maxLines selection, same slice byte cap,
 * same full-file sha256/sizeBytes/totalLines metadata, same strict reply shape.
 * `body === null` stands for an absent path: an ENOENT-coded error, which
 * read-first-io's sliceError classifies as { kind: "missing" }.
 */
export function boundedReadReply(
  input: { hostId: string; relativePath: string; offset: number; maxLines: number },
  body: string | null,
): BoundedReadResult {
  if (body === null) {
    const error = new Error(`ENOENT: no such file or directory, open '${input.relativePath}'`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  const sizeBytes = Buffer.byteLength(body, "utf8");
  if (sizeBytes > BOUNDED_READ_MAX_FILE_BYTES) {
    throw new Error(`lane_pilot_read_file_exceeds_${BOUNDED_READ_MAX_FILE_BYTES}_bytes`);
  }
  if (body.includes("\0")) throw new Error("lane_pilot_read_binary_rejected");
  const lines = body === "" ? [] : body.split("\n");
  const totalLines = lines.length;
  const selected: string[] = [];
  let sliceBytes = 0;
  let truncated = false;
  const last = Math.min(totalLines, input.offset + input.maxLines);
  for (let idx = input.offset; idx < last; idx += 1) {
    const line = lines[idx]!;
    const extra = selected.length === 0
      ? Buffer.byteLength(line, "utf8")
      : Buffer.byteLength(`\n${line}`, "utf8");
    if (sliceBytes + extra > BOUNDED_READ_MAX_SLICE_BYTES) { truncated = true; break; }
    selected.push(line);
    sliceBytes += extra;
  }
  const content = selected.join("\n");
  return {
    schemaVersion: LANE_PILOT_READ_SCHEMA_VERSION,
    hostId: input.hostId,
    path: input.relativePath.replace(/\\/g, "/"),
    content,
    contentEncoding: "utf8",
    sha256: sha256Hex(body),
    sizeBytes,
    totalLines,
    offset: input.offset,
    maxLines: input.maxLines,
    lineStart: input.offset + 1,
    lineEnd: selected.length === 0 ? input.offset : input.offset + selected.length,
    truncated: truncated || input.offset + selected.length < totalLines,
    returnedBytes: Buffer.byteLength(content, "utf8"),
  };
}

/** One-line `readBoundedFile` branch for a fixture's experimental_callHostRpc: resolves the body for the requested path (null = absent). */
export function boundedReadCall(
  call: { input: unknown },
  hostId: string,
  body: string | null | ((relativePath: string) => string | null),
): BoundedReadResult {
  const input = call.input as { relativePath?: unknown; offset?: unknown; maxLines?: unknown };
  const relativePath = String(input.relativePath ?? "");
  return boundedReadReply({
    hostId,
    relativePath,
    offset: typeof input.offset === "number" ? input.offset : 0,
    maxLines: typeof input.maxLines === "number" ? input.maxLines : 1,
  }, typeof body === "function" ? body(relativePath) : body);
}
