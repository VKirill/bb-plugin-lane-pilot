import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORLD_ASSETS, mountWorldAssets, worldAssetResponse } from "../src/rooms/world-assets/server";

describe("world assets over HTTP", () => {
  it("serves each whitelisted GLB byte for byte with its type and cache headers", async () => {
    for (const name of WORLD_ASSETS) {
      const response = await worldAssetResponse(name);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("model/gltf-binary");
      expect(response.headers.get("cache-control")).toMatch(/max-age=\d+/);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.equals(readFileSync(new URL(`../assets/world/${name}`, import.meta.url)))).toBe(true);
      expect(bytes.subarray(0, 4).toString()).toBe("glTF");
    }
  });

  it("answers 304 when the browser already has the file", async () => {
    const first = await worldAssetResponse("office-cars.glb");
    const again = await worldAssetResponse("office-cars.glb", first.headers.get("etag"));
    expect(again.status).toBe(304);
  });

  it("registers one exact GET route per whitelisted name and nothing else", async () => {
    const routes: Array<{ method: string; path: string; handler: (c: unknown) => Promise<Response> }> = [];
    mountWorldAssets({ http: { route: (method: string, path: string, handler: never) => routes.push({ method, path, handler }) } } as never);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(WORLD_ASSETS.map((n) => `GET /world/assets/${n}`).sort());
    const response = await routes[0]!.handler({ req: { header: () => undefined } });
    expect(response.status).toBe(200);
  });
});
