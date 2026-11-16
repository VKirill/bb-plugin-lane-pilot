import { resolve } from "node:path";
import type { ReadFirstFile, ReadFirstIo, SliceOutcome } from "./execution-packet";
import { parseReadFirstSelector } from "./read-first";

/**
 * The one production transport for read_first sources: whole files through the SDK
 * files.read (only after a bounded probe proves the source fits MAX_SOURCE_BYTES),
 * line windows through the host readBoundedFile contract. Errors are classified —
 * absent paths return null/missing, unsupported bounds defer to an on-site read,
 * and path-policy or uncertain failures throw as named errors.
 */

type FilesReader = {
  read(args: { hostId: string; rootPath: string; path: string }): Promise<{
    content?: unknown; contentEncoding?: string; sha256?: string; sizeBytes?: number;
  }>;
};

type BoundedReply = {
  content: string; sha256: string; sizeBytes: number; totalLines: number;
  lineStart: number; lineEnd: number; returnedBytes: number; truncated: boolean;
};

type BoundedHost = {
  call(method: "readBoundedFile", input: {
    requestedHostId: string; projectCwd: string; relativePath: string; offset: number; maxLines: number;
  }, opts: { hostId: string; timeoutMs: number }): Promise<BoundedReply>;
};

const READ_WHOLE_TIMEOUT_MS = 30_000;

function readWholeError(cause: unknown): null {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/ENOENT|no such file|not found|does not exist|is a directory/i.test(message)) return null;
  throw cause;
}

function sliceError(cause: unknown): SliceOutcome {
  const message = cause instanceof Error ? cause.message : String(cause);
  // The primitive lstats directly: an absent path (or a file used as a directory) is a
  // real ENOENT/ENOTDIR, not a lane_pilot_read_* code. Only those codes mean "missing".
  const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR" || /\bENOENT\b|\bENOTDIR\b/.test(message)) {
    return { kind: "missing" };
  }
  if (/lane_pilot_read_target_must_be_regular_file|lane_pilot_read_parent_must_be_directory/.test(message)) {
    return { kind: "missing" };
  }
  if (/lane_pilot_read_file_exceeds_(\d+)_bytes/.test(message)) {
    return { kind: "deferred", reason: "larger than the host read limit" };
  }
  if (/lane_pilot_read_binary_rejected|lane_pilot_read_not_valid_utf8/.test(message)) {
    return { kind: "deferred", reason: "not readable as text" };
  }
  if (/EACCES|permission denied|operation not permitted/i.test(message)) {
    return { kind: "deferred", reason: "not readable on the host" };
  }
  if (/lane_pilot_read_path_escaped_workspace|lane_pilot_read_path_cannot_traverse_symlink/.test(message)) {
    throw cause;
  }
  // A host that predates the bounded-read contract cannot serve the slice; defer to an
  // on-site read rather than claiming the source is absent or failing the task.
  if (/(unknown|no such|not)[^.\n]{0,40}method|method[^.\n]{0,40}(unknown|not found|unsupported|not supported)|does not support|not supported by the host|unsupported host/i.test(message)) {
    return { kind: "deferred", reason: "the host does not support bounded file reads" };
  }
  // Uncertain transport failures stay named failures.
  throw cause;
}

export function readFirstIo(
  deps: { files: FilesReader; host: BoundedHost },
  opts: { hostId: string; rootPath: string; repoRootPath?: string | null },
): ReadFirstIo {
  const { files, host } = deps;
  const { hostId, rootPath, repoRootPath = null } = opts;
  const sourceRoot = (path: string): { root: string; relative: string } => {
    const selected = parseReadFirstSelector(path);
    if (selected.scope === "workspace") return { root: rootPath, relative: selected.path };
    if (!repoRootPath) {
      throw new Error(`read_first repo: source needs the repository root, which this workspace does not have: ${path}`);
    }
    return { root: repoRootPath, relative: selected.path };
  };
  return {
    readWhole: async (path) => {
      const source = sourceRoot(path);
      const file = await files.read({ hostId, rootPath: source.root, path: resolve(source.root, source.relative) }).then(
        (result) => result as ReadFirstFile | null,
        (cause: unknown) => readWholeError(cause),
      );
      // null means the read error was classified as absent; a resolved value without text
      // content is a malformed response, not a missing file.
      if (file == null) return null;
      if (typeof file.content !== "string") {
        throw new Error(`read_first source read returned no text content: ${path}`);
      }
      return file;
    },
    readSlice: async (path, offset, maxLines) => {
      const source = sourceRoot(path);
      try {
        const reply = await host.call("readBoundedFile", {
          requestedHostId: hostId,
          projectCwd: source.root,
          relativePath: source.relative,
          offset,
          maxLines,
        }, { hostId, timeoutMs: READ_WHOLE_TIMEOUT_MS });
        return {
          kind: "slice",
          slice: {
            content: reply.content,
            sha256: reply.sha256,
            sizeBytes: reply.sizeBytes,
            totalLines: reply.totalLines,
            lineStart: reply.lineStart,
            lineEnd: reply.lineEnd,
            returnedBytes: reply.returnedBytes,
            truncated: reply.truncated,
          },
        };
      } catch (cause) {
        return sliceError(cause);
      }
    },
  };
}
