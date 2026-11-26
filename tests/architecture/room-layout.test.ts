import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The room layout from .ai-factory/ARCHITECTURE.md: a room's top level holds only its public index, migrations,
 * settings and the layer folders; `server/` holds only index.ts, room.ts and handlers/services/repositories.
 * Host code stays at room level: a file that imports fs or child_process may not live under server/ (remote-git-detect)
 * or models/, and host-worker keeps handlers/ at its top (ARCHITECTURE.md, "Server ↔ host machines").
 * room-layout.json lists the entries that were off the layout when the rule came; it may only shrink and ends empty.
 * After a move run `UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture` to drop the moved entries.
 */
const ROOT = join(__dirname, "../..");
const ROOMS = join(ROOT, "src/rooms");
const BASELINE_PATH = join(__dirname, "room-layout.json");
/** Cross-cutting folders that keep the shape ARCHITECTURE.md gives them. */
const CROSS_CUTTING = new Set(["contracts", "core", "storage"]);
const TOP = new Set(["index.ts", "migrations.ts", "settings.ts", "models", "server", "ui"]);
const SERVER = new Set(["index.ts", "room.ts", "handlers", "services", "repositories"]);
const HOST_IMPORT = /from\s+["'](?:node:)?(?:fs|fs\/promises|child_process)["']/;
const isHostFile = (path: string) => /\.tsx?$/.test(path) && statSync(path).isFile() && HOST_IMPORT.test(readFileSync(path, "utf8"));

const offLayout = (): string[] => readdirSync(ROOMS)
  .filter((room) => !CROSS_CUTTING.has(room) && statSync(join(ROOMS, room)).isDirectory())
  .flatMap((room) => {
    const top = readdirSync(join(ROOMS, room)).filter((name) => !TOP.has(name) && !name.startsWith("."))
      .filter((name) => !isHostFile(join(ROOMS, room, name)) && !(room === "host-worker" && name === "handlers"))
      .map((name) => `${room}/${name}`);
    const server = existsSync(join(ROOMS, room, "server"))
      ? readdirSync(join(ROOMS, room, "server")).filter((name) => !SERVER.has(name) && !name.startsWith(".")).map((name) => `${room}/server/${name}`)
      : [];
    return [...top, ...server];
  })
  .sort();

describe("room layout", () => {
  it("no room entry is off the ARCHITECTURE.md layout beyond the shrinking baseline", () => {
    const actual = offLayout();
    const first = !existsSync(BASELINE_PATH);
    let baseline = first ? [] : JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[];
    if (process.env.UPDATE_ARCH_BASELINE === "1" || first) {
      // Shrinks only: an entry the baseline does not name stays a failure (the first write names them all).
      baseline = first ? actual : baseline.filter((entry) => actual.includes(entry));
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 1) + "\n");
    }
    expect(actual.filter((entry) => !baseline.includes(entry)), "move it into models/ or server/{handlers,services,repositories}/").toEqual([]);
    expect(baseline.filter((entry) => !actual.includes(entry)), "moved: run UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture").toEqual([]);
  });
});
