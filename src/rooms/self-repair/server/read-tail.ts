import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The last `bytes` of a file (the plugin log); also the wall journal's reader, since only this file may read the hub's disk. */
export function readTail(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally { closeSync(fd); }
}
