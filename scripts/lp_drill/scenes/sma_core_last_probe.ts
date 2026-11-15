// Probe of scenes/sma_core_last.py (n1499, the per-workflow entries an agent sees): loads the REAL plugin of THIS checkout (the commit under drill) on a fake host,
// reads the instructions the PM's lane_pilot_route tool is registered with, and prints the graph ids they name next to the shipped graphs read from the catalog,
// as one JSON line. It judges nothing: the scene compares the two lists. No model, no hub write, nothing outside the machine.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../../server";
import { resolveSibling } from "../../../src/rooms/sma-map/siblings";
import { builtinWorkflows } from "../../../src/rooms/workflow/builtin";

async function coreWindowBuild(): Promise<Record<string, unknown>> {
  const core = resolveSibling("core");
  if (core.root === null) return { absent: core.why };
  let coreRev: string | undefined;
  let toolchainDir: string | null = null;
  try {
    coreRev = execFileSync("git", ["-C", core.root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const { buildPluginApp } = await import(`${core.root}/packages/plugin-build/src/build-plugin-app.ts`);
    const { resolvePluginBuildToolchain } = await import(`${core.root}/packages/plugin-build/src/toolchain.ts`);
    toolchainDir = await mkdtemp(join(tmpdir(), "bb-toolchain-"));
    const toolchain = await resolvePluginBuildToolchain(toolchainDir, {
      onFetchStart: () => { throw new Error("plugin build toolchain is not installed locally — refusing a network install"); },
    });
    if (typeof toolchain.tailwindCssDir !== "string" || !toolchain.tailwindCssDir.startsWith(core.root))
      throw new Error(`toolchain resolved outside the core checkout: ${String(toolchain.tailwindCssDir)}`);
    const dir = await mkdtemp(join(tmpdir(), "bb-plugin-dist-swap-"));
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "bb-plugin-dist-swap-fixture", version: "0.0.0", bb: { name: "Dist swap fixture", description: "Builds its window twice.", branding: { icon: "Zap" }, server: "./server.ts", app: "./app.tsx" } }));
      await writeFile(join(dir, "server.ts"), "export default function plugin() {}\n");
      const app = (marker: string, cls: string) => `export default function App() { return <p className="${cls}">${marker}</p>; }\n`;
      const opts = { minify: false, hostProvidedZod: false };
      const metaInfo = (text: string | null) => {
        try {
          const meta = JSON.parse(text ?? "") as { builtWith?: { bbVersion?: unknown }; pluginId?: unknown };
          return { bb: typeof meta.builtWith?.bbVersion === "string" ? meta.builtWith.bbVersion : null,
                   plugin: typeof meta.pluginId === "string" ? meta.pluginId : null };
        } catch { return { bb: null, plugin: null }; }
      };
      const snapshot = async () => ({
        dist: (await readdir(join(dir, "dist"))).sort(),
        js: await readFile(join(dir, "dist", "app.js"), "utf8").then((text) => text, () => null),
        css: await readFile(join(dir, "dist", "app.css"), "utf8").then((text) => text, () => null),
        meta: await readFile(join(dir, "dist", "app.meta.json"), "utf8").then((text) => text, () => null),
      });
      await writeFile(join(dir, "app.tsx"), app("first-marker", "flex p-1"));
      await buildPluginApp(dir, "0.9.0-test", toolchain, opts);
      const first = await snapshot();
      await writeFile(join(dir, "app.tsx"), app("second-marker", "grid p-2"));
      await buildPluginApp(dir, "0.9.1-test", toolchain, opts);
      const second = await snapshot();
      await writeFile(join(dir, "app.tsx"), "export default function App( {\n");
      let rejected = false;
      try { await buildPluginApp(dir, "0.9.1-test", toolchain, opts); } catch { rejected = true; }
      const failed = await snapshot();
      return {
        coreRev,
        builds: [
          { marker: first.js?.includes("first-marker") === true, cssBytes: first.css?.length ?? 0, meta: metaInfo(first.meta) },
          { second: second.js?.includes("second-marker") === true, first: second.js?.includes("first-marker") === true,
            cssBytes: second.css?.length ?? 0, cssChanged: first.css !== null && second.css !== null && first.css !== second.css,
            meta: metaInfo(second.meta) },
        ],
        dist: [first.dist, second.dist, failed.dist],
        failure: { rejected, jsSame: failed.js === second.js, cssSame: failed.css === second.css, metaSame: failed.meta === second.meta },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (cause) {
    return { ...(coreRev ? { coreRev } : {}), threw: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (toolchainDir !== null) await rm(toolchainDir, { recursive: true, force: true });
  }
}

async function main() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  try {
    const route = harness.registrations.agentTools.find((tool) => tool.name === "lane_pilot_route") as unknown as { instructions?: string } | undefined;
    const listed = /Ready graphs shipped with Lane Pilot: ([^;]*);/.exec(route?.instructions ?? "")?.[1]?.split(", ") ?? [];
    const all = builtinWorkflows();
    const ready = all.filter((w) => (w.status === "published" || w.status === "tested") && !w.internal && !w.startedBy).map((w) => w.id);
    const hidden = all.filter((w) => w.internal || w.startedBy).map((w) => w.id);
    const out: Record<string, unknown> = { n1499: { registered: route !== undefined, listed, ready, hidden } };
    out.n1748 = await coreWindowBuild();
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } finally {
    await harness.lifecycle.dispose();
  }
}
void main().catch((cause: unknown) => { process.stdout.write(`${JSON.stringify({ n1499: { threw: cause instanceof Error ? cause.message : String(cause) } })}\n`); });
