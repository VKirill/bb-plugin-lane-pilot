import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { pluginRootFromModule } from "@lane-pilot/kit";

/**
 * The binary assets of the pixel world (rigged people, cars), served over HTTP instead of being embedded in app.js.
 * Files live in assets/world/ at the plugin root and ship with the repository. The browser fetches
 * /api/v1/plugins/lane-pilot/http/world/assets/<name> (same origin as the BB app).
 *
 * Routes are exact-match, so the whitelist is the list of routes: a name outside it has no route, and no part of the
 * request ever reaches the file system as a path.
 */
export const WORLD_ASSETS = ["office-people.glb", "office-cars.glb"] as const;
export type WorldAssetName = (typeof WORLD_ASSETS)[number];

/** A day: the files change with a release, and the ETag turns the revalidation after that into a 304. */
const CACHE_CONTROL = "public, max-age=86400";

type Cached = { body: ArrayBuffer; etag: string };
const cache = new Map<string, Promise<Cached>>();

function assetDir(): string {
  return join(pluginRootFromModule(import.meta.url), "assets", "world");
}

function load(name: WorldAssetName): Promise<Cached> {
  let pending = cache.get(name);
  if (!pending) {
    pending = readFile(join(assetDir(), name)).then((bytes) => ({
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      etag: `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`,
    }));
    // A missing file is not remembered: copying it in later needs no restart
    pending.catch(() => cache.delete(name));
    cache.set(name, pending);
  }
  return pending;
}

/** The response for one asset: the file, or 304 when `ifNoneMatch` carries its ETag, or 404 when the file is missing. */
export async function worldAssetResponse(name: WorldAssetName, ifNoneMatch?: string | null): Promise<Response> {
  let file: Cached;
  try {
    file = await load(name);
  } catch {
    return Response.json({ ok: false, error: `world asset ${name} is missing` }, { status: 404 });
  }
  const headers = { "Cache-Control": CACHE_CONTROL, ETag: file.etag };
  if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim() === file.etag)) return new Response(null, { status: 304, headers });
  return new Response(file.body, { status: 200, headers: { ...headers, "Content-Type": "model/gltf-binary", "Content-Length": String(file.body.byteLength) } });
}

/** Registers GET /world/assets/<name> for every whitelisted file. */
export function mountWorldAssets(bb: BbPluginApi): void {
  for (const name of WORLD_ASSETS) {
    bb.http.route("GET", `/world/assets/${name}`, (c) => worldAssetResponse(name, c.req.header("if-none-match")));
  }
}
