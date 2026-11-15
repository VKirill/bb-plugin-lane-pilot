import { MAX_SOURCE_BYTES } from "@lane-pilot/contracts";
import { BOUNDED_READ_MAX_FILE_BYTES, BOUNDED_READ_MAX_SLICE_BYTES, sha256Hex } from "@lane-pilot/kit";
import { parseReadFirstHints, type ReadFirstHint } from "./read-first";

export type ReadFirstFile = {
  content: string;
  contentEncoding?: "utf8" | "base64";
  sha256?: string;
  sizeBytes?: number;
};

/**
 * One bounded host read: the returned lines are a slice, while sha256/sizeBytes/
 * totalLines always describe the whole file. `lineEnd` is the last returned line
 * (1-based, inclusive); `truncated` only means the file continues past the slice.
 */
export type BoundSlice = {
  content: string;
  sha256: string;
  sizeBytes: number;
  totalLines: number;
  lineStart: number;
  lineEnd: number;
  returnedBytes: number;
  truncated: boolean;
};

export type SliceOutcome =
  | { kind: "slice"; slice: BoundSlice }
  | { kind: "missing" }
  | { kind: "deferred"; reason: string };

/**
 * Source IO for read_first. `readWhole` returns null only when the path is absent;
 * thrown errors are named failures, never silently "missing". `readSlice` reads a
 * bounded line window through the host contract and classifies failures itself.
 */
export type ReadFirstIo = {
  readWhole: (path: string) => Promise<ReadFirstFile | null>;
  readSlice: (path: string, offset: number, maxLines: number) => Promise<SliceOutcome>;
};

export type ExecutionPacketEntry = {
  path: string;
  sha256: string;
  windows: Array<{ startLine: number; endLine: number; excerpt: string }>;
  /** The hint named a path the workspace does not have (or a directory); the writer is told so. */
  missing?: true;
  /** The source cannot be inlined (too large, binary, unsupported host bound); the writer must read it on site. */
  deferred?: { reason: string; windows: Array<{ startLine: number; endLine: number }> };
};

export type ExecutionPacket = {
  schemaVersion: 1;
  entries: ExecutionPacketEntry[];
  sha256: string;
  truncated: boolean;
};

const MAX_PACKET_BYTES = 24 * 1024;
// Bounds of the host readBoundedFile contract input (contracts/host/files.ts).
const BOUNDED_PAGE_LINES = 2000;
const BOUNDED_MAX_OFFSET = 100_000;

type Selection = { startLine: number; endLine: number; excerpt: string; requestedEndLine?: number };

function decodeFile(file: ReadFirstFile, path: string): string {
  const content = file.contentEncoding === "base64"
    ? Buffer.from(file.content, "base64").toString("utf8")
    : file.content;
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_SOURCE_BYTES || (file.sizeBytes !== undefined && file.sizeBytes > MAX_SOURCE_BYTES)) {
    throw new Error(`read_first source exceeds ${MAX_SOURCE_BYTES} bytes: ${path}`);
  }
  return content;
}

function selectLines(hint: ReadFirstHint, source: string): Selection[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const requested = hint.windows.length ? hint.windows : [{ startLine:1, endLine:lines.length }];
  return requested.map(({ startLine, endLine }) => {
    if (startLine < 1 || endLine < startLine || startLine > lines.length) {
      throw new Error(`read_first line window is outside ${hint.path} (${lines.length} lines)`);
    }
    const boundedEndLine = Math.min(endLine, lines.length);
    return { startLine, endLine:boundedEndLine, excerpt:lines.slice(startLine - 1, boundedEndLine).join("\n") };
  });
}

/** Slice content keeps per-line `\r`; the whole-file path normalizes `\r\n?` first, so match it per line. */
function normalizeSlice(content: string): string {
  return content.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line).join("\n");
}

type SourceRead =
  | { kind: "ready"; sha256: string; selections: Selection[]; cutShort: boolean }
  | { kind: "missing" }
  | { kind: "deferred"; reason: string; sha256: string; windows: Array<{ startLine: number; endLine: number }> };

/**
 * Explicit windows go straight to the bounded host slice — a whole-file SDK read is
 * never used for them. Windowless hints get a one-line probe: small files keep the
 * whole-file path, larger ones become a deferred on-site read instead of an
 * unbounded transfer or a silent first-N-lines substitute.
 */
async function readBoundedSource(
  hint: ReadFirstHint,
  io: ReadFirstIo,
): Promise<SourceRead> {
  if (!hint.windows.length) {
    const probe = await io.readSlice(hint.path, 0, 1);
    if (probe.kind === "missing") return { kind: "missing" };
    if (probe.kind === "deferred") return { kind: "deferred", reason: probe.reason, sha256: "", windows: [] };
    const meta = probe.slice;
    if (meta.sizeBytes > BOUNDED_READ_MAX_FILE_BYTES) {
      return { kind: "deferred", reason: `exceeds the ${BOUNDED_READ_MAX_FILE_BYTES}-byte host read limit`, sha256: "", windows: [] };
    }
    if (meta.sizeBytes > MAX_SOURCE_BYTES) {
      return { kind: "deferred", reason: `exceeds ${MAX_SOURCE_BYTES} bytes (${meta.totalLines} lines)`, sha256: meta.sha256, windows: [] };
    }
    const file = await io.readWhole(hint.path);
    if (!file || typeof file.content !== "string") return { kind: "missing" };
    const source = decodeFile(file, hint.path);
    return {
      kind: "ready",
      sha256: file.sha256 && /^[a-f0-9]{64}$/.test(file.sha256) ? file.sha256 : sha256Hex(source),
      selections: selectLines(hint, source),
      cutShort: false,
    };
  }

  const selections: Selection[] = [];
  const ranges = hint.windows.map((w) => ({ startLine: w.startLine, endLine: w.endLine }));
  // One whole-file identity binds every page of every window: sha256/sizeBytes/totalLines
  // are file-level metadata, so any page that disagrees means the source changed mid-read.
  let sha256 = "";
  let sizeBytes = -1;
  let totalLines = -1;
  let sawSlice = false;
  let cutShort = false;
  for (const window of hint.windows) {
    let offset = window.startLine - 1;
    if (offset > BOUNDED_MAX_OFFSET) {
      return { kind: "deferred", reason: `the window starts past the ${BOUNDED_MAX_OFFSET}-line host read bound`, sha256: "", windows: ranges };
    }
    const want = window.endLine - window.startLine + 1;
    const parts: string[] = [];
    let covered = 0;
    while (covered < want) {
      if (offset > BOUNDED_MAX_OFFSET) break;
      const outcome = await io.readSlice(hint.path, offset, Math.min(BOUNDED_PAGE_LINES, want - covered));
      if (outcome.kind === "missing") {
        if (!sawSlice) return { kind: "missing" };
        throw new Error(`read_first source changed while reading: ${hint.path}`);
      }
      if (outcome.kind === "deferred") {
        return { kind: "deferred", reason: outcome.reason, sha256, windows: ranges };
      }
      const slice = outcome.slice;
      if (!sawSlice) {
        sawSlice = true;
        sha256 = slice.sha256;
        sizeBytes = slice.sizeBytes;
        totalLines = slice.totalLines;
        if (sizeBytes > BOUNDED_READ_MAX_FILE_BYTES) {
          return { kind: "deferred", reason: `exceeds the ${BOUNDED_READ_MAX_FILE_BYTES}-byte host read limit`, sha256: "", windows: ranges };
        }
      } else if (slice.sha256 !== sha256 || slice.sizeBytes !== sizeBytes || slice.totalLines !== totalLines) {
        throw new Error(`read_first source changed while reading: ${hint.path}`);
      }
      if (slice.lineStart !== offset + 1) {
        throw new Error(`read_first source changed while reading: ${hint.path}`);
      }
      const got = slice.lineEnd - offset;
      if (got <= 0) break;
      parts.push(normalizeSlice(slice.content));
      covered += got;
      offset += got;
      if (offset >= slice.totalLines) break;
    }
    if (window.startLine > totalLines) {
      throw new Error(`read_first line window is outside ${hint.path} (${totalLines} lines)`);
    }
    if (!covered) {
      return { kind: "deferred", reason: `the window at line ${window.startLine} exceeds the ${BOUNDED_READ_MAX_SLICE_BYTES}-byte slice limit`, sha256, windows: ranges };
    }
    const endLine = window.startLine - 1 + covered;
    if (endLine < Math.min(window.endLine, totalLines)) cutShort = true;
    selections.push({ startLine: window.startLine, endLine, excerpt: parts.join("\n"), requestedEndLine: Math.min(window.endLine, totalLines) });
  }
  return { kind: "ready", sha256, selections, cutShort };
}

export async function buildExecutionPacket(
  rawHints: string[],
  io: ReadFirstIo | ((path: string) => Promise<ReadFirstFile | null>),
): Promise<ExecutionPacket> {
  const hints = parseReadFirstHints(rawHints);
  const entries: ExecutionPacketEntry[] = [];
  let remaining = MAX_PACKET_BYTES;
  let truncated = false;
  const readWhole = typeof io === "function" ? io : io.readWhole;
  const readSlice = typeof io === "function" ? undefined : io.readSlice;
  for (const hint of hints) {
    // The excerpt budget is spent: keep every requested reference visible as a deferred
    // on-site read instead of silently dropping the path, and do not read its content.
    if (truncated) {
      entries.push({ path:hint.path, sha256:"", windows:[],
        deferred:{ reason:"not inlined: the packet budget is spent", windows:hint.windows.map((w) => ({ startLine:w.startLine, endLine:w.endLine })) } });
      continue;
    }
    let sha256 = "";
    let selections: Selection[];
    if (readSlice) {
      const source = await readBoundedSource(hint, { readWhole, readSlice });
      if (source.kind === "missing") {
        entries.push({ path:hint.path, sha256:"", windows:[], missing:true });
        continue;
      }
      if (source.kind === "deferred") {
        entries.push({ path:hint.path, sha256:source.sha256, windows:[], deferred:{ reason:source.reason, windows:source.windows } });
        continue;
      }
      sha256 = source.sha256;
      selections = source.selections;
      if (source.cutShort) truncated = true;
    } else {
      const file = await readWhole(hint.path).catch(() => null);
      if (!file || typeof file.content !== "string") {
        entries.push({ path:hint.path, sha256:"", windows:[], missing:true });
        continue;
      }
      const source = decodeFile(file, hint.path);
      selections = selectLines(hint, source);
      sha256 = file.sha256 && /^[a-f0-9]{64}$/.test(file.sha256) ? file.sha256 : sha256Hex(source);
    }
    const included: Selection[] = [];
    for (const selection of selections) {
      const header = `${hint.path} L${selection.startLine}-L${selection.endLine}\n`;
      const headerBytes = Buffer.byteLength(header, "utf8");
      if (remaining <= headerBytes) { truncated = true; break; }
      const excerptBytes = Buffer.from(selection.excerpt, "utf8");
      const available = remaining - headerBytes;
      const excerpt = excerptBytes.byteLength > available ? excerptBytes.subarray(0, available).toString("utf8") : selection.excerpt;
      included.push({ startLine: selection.startLine, endLine: selection.endLine, excerpt });
      remaining -= headerBytes + Buffer.byteLength(excerpt, "utf8");
      if (excerptBytes.byteLength > available) { truncated = true; break; }
    }
    // Windows the budget or a host bound kept out of the excerpt still name their requested
    // ranges: they ride the entry's deferred field with the proven hash, never vanish.
    const deferredRanges: Array<{ startLine: number; endLine: number }> = [];
    const deferredReasons = new Set<string>();
    selections.forEach((selection, index) => {
      const requestedEnd = selection.requestedEndLine ?? selection.endLine;
      if (index >= included.length) {
        deferredRanges.push({ startLine: selection.startLine, endLine: requestedEnd });
        deferredReasons.add("not inlined: the packet budget is spent");
      } else if (requestedEnd > selection.endLine) {
        deferredRanges.push({ startLine: selection.endLine + 1, endLine: requestedEnd });
        deferredReasons.add("not fully covered: the host read bound");
      }
    });
    entries.push({
      path:hint.path, sha256, windows:included,
      ...(deferredRanges.length ? { deferred:{ reason:[...deferredReasons].join("; "), windows:deferredRanges } } : {}),
    });
  }
  const packetCore = { schemaVersion: 1 as const, entries, truncated };
  return { ...packetCore, sha256: sha256Hex(JSON.stringify(packetCore)) };
}

/** The line count the pm-read scout threshold reads; one home so the pipeline gate and the scout agree. */
export function packetSelectedLines(packet: ExecutionPacket): number {
  return packet.entries.reduce((total, entry) => total + entry.windows.reduce((sum, window) => sum + window.excerpt.split(/\r?\n/).length, 0), 0);
}

/**
 * The writer is an agent with file access: name what to read instead of pasting it. The packet's
 * hashes stay in the receipt; the short prefix lets the writer notice a file that changed since.
 */
export function renderExecutionPacket(packet: ExecutionPacket): string {
  const lines = packet.entries.flatMap((entry) => {
    if (entry.missing) return [`- ${entry.path} (not in the workspace; skip it)`];
    const out: string[] = [];
    if (entry.windows.length) {
      out.push(...entry.windows.map((w) => `- ${entry.path} L${w.startLine}-L${w.endLine} (sha256 ${entry.sha256.slice(0, 8)})`));
    } else if (!entry.deferred) {
      out.push(`- ${entry.path} (sha256 ${entry.sha256.slice(0, 8)})`);
    }
    if (entry.deferred) {
      const status = entry.sha256 ? `file sha256 ${entry.sha256.slice(0, 8)}` : "content hash unknown";
      const tail = `${status}; ${entry.deferred.reason} — read it on site before executing`;
      if (!entry.deferred.windows.length) {
        out.push(`- ${entry.path} (whole file; ${tail})`);
      } else {
        const ranges = entry.deferred.windows.map((w) => `L${w.startLine}-L${w.endLine}`).join(" ");
        out.push(`- ${entry.path} ${ranges} (${tail})`);
      }
    }
    return out;
  });
  if (!lines.length) return "";
  return ["Read these before editing; they are the context for this task:", ...lines].join("\n");
}
