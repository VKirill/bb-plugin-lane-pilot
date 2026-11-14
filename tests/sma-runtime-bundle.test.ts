import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("loads the shipped workflow facts without the development TypeScript compiler", async () => {
  const root = mkdtempSync(join(tmpdir(), "sma-runtime-"));
  try {
    const bundle = join(root, "facts.mjs");
    await build({
      entryPoints: [resolve("src/rooms/sma-map/hollow-facts.ts")], outfile: bundle,
      bundle: true, platform: "node", format: "esm", logLevel: "silent",
      plugins: [{ name: "no-development-compiler", setup(api) {
        api.onResolve({ filter: /^typescript$/ }, () => ({ errors: [{ text: "TypeScript is unavailable on the production hub" }] }));
      } }],
    });
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { SMA_HOLLOW_FACTS } from ${JSON.stringify(pathToFileURL(bundle).href)}; console.log(SMA_HOLLOW_FACTS.graphs.length);`], { encoding: "utf8" });
    expect(Number(output.trim())).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
