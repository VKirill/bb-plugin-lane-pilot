import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, accept: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, accept) : accept.test(name) ? [path] : [];
  });
}

/** Absolute paths of the sources of one runtime face of every room: src/rooms/<room>/server/** or src/rooms/<room>/ui/**. */
export function roomFaceFiles(face: "server" | "ui", accept = /\.tsx?$/): string[] {
  const rooms = join(ROOT, "src/rooms");
  return readdirSync(rooms).flatMap((room) => {
    const dir = join(rooms, room, face);
    try {
      return statSync(dir).isDirectory() ? walk(dir, accept) : [];
    } catch {
      return [];
    }
  }).sort();
}

/** Same, relative to the plugin root with forward slashes. */
export function roomFaceRelative(face: "server" | "ui", accept?: RegExp): string[] {
  return roomFaceFiles(face, accept).map((file) => file.slice(ROOT.length + 1));
}
