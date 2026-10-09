# @lane-pilot/pixel-world

The three.js client engine of the pixel world (the council office is its first scene). It knows nothing about
Lane Pilot or the council: scenes, props, behaviour and layout stay in `src/rooms/*/ui` and import this package.
`three` is a peer dependency; the browser-only parts take the `THREE` module as an argument.

```text
scene built with the props kit ─► batchStatic ─► PixelPresenter.render (low-res target + depth outlines)
                                    camera: PixelCameraControls   people/cars: loadPeople, loadVehicles (GLB over HTTP)
                                    walking: createNavGrid (A* over data)
```

## Public API (`src/index.ts`)

| Module | Export | What it does |
|---|---|---|
| `pixel` | `PixelPresenter` | Renders into a small target and presents it with a nearest upscale, depth outlines and a rim light. `placeCamera`, `project` (world to CSS px), `resize`, `setScale`, `stats` (draw calls and triangles of the last scene pass; a page can also set `globalThis.__pixelWorldStats = {}` to read them). |
| | `getPixelStyle(THREE)` | The shared 3-tone toon gradient. `toon(params)` makes a material that also carries the front-wall cut; `setFrontWalls(yaw)` flags the walls between the camera and the room; `setWallBounds({minX,maxX,minZ,maxZ})` says where the outer walls stand (default: the office floor, x ±20, z ±10). |
| | `PIXELS_PER_UNIT`, `ZOOM_SCALES`, `CAMERA_YAW`, `CAMERA_PITCH`, `snapYaw`, `sunPosition` | The 2:1 dimetric camera constants and helpers. |
| `camera` | `PixelCameraControls` | Orbit controls: drag turns by whole views, right/shift-drag or two fingers pan, wheel or pinch step the integer zoom, double-click resets. `attach()` / `dispose()`, `fit(viewHeight, centerY, canvasHeight)` after a resize, `update(dt)` once per frame (eases the shown view), `apply()`. The `target` object can outlive the scene (pass it again after a remount). |
| | `CAMERA_VIEW_DEFAULT`, `CameraView` | The default view and its type. |
| `props-kit` | `createPropsKit({ THREE, scene, disposables, gridOrigin? })` | `box`, `gridBox`, `blob`, `cylinder`, `material` (cached toon materials by colour and opacity), `setPart(name)` (names the meshes built next, for the geometry audit). `PropsKit` is the type the prop modules receive. |
| `batch` | `batchStatic(THREE, root, { isolate? })` | Merges the static toon meshes under `root` into one opaque and one transparent mesh: colours become vertex colours (alpha too), world matrices are baked in, so the wall cut keeps working. A group matched by `isolate` is merged on its own, in its own space, and stays a group (it can still hide or move). Meshes with `userData.noBatch`, invisible, skinned or textured ones are left alone. Call it once, after the build and before people and cars are added. Returns `{ meshes, sourceMeshes, sourceTriangles, dispose }`. |
| `nav` | `createNavGrid({ bounds, obstacles, step?, margin?, segmentMargin? })` | Walkable area from plain rectangles. `isBlocked(x, z, margin?)`, `isSegmentBlocked(...)`, `findPath(start, target)` (A* on a grid built once, string-pulled). Obstacles are filed into buckets, so a query tests the few rectangles near the point, not all of them. |
| `assets` | `loadModel(name)` | Downloads a GLB from the asset base (bytes cached per page), parses it, gives the bones their plain names back, offers `clone(node)` (SkeletonUtils). |
| | `toToon(THREE, mesh, owned)` | Swaps a loaded material for the toon one (texture kept). |
| | `setAssetBase(url)`, `assetUrl(name)`, `DEFAULT_ASSET_BASE` | Where the files come from; default `/api/v1/plugins/lane-pilot/http/world/assets/` (served by `src/rooms/world-assets/server` from `assets/world/`). |
| `people` | `loadPeople(THREE)` | Eight rigged characters from `office-people.glb`: `createPerson(variant)` gives a `Person` with `play(clip)` (crossfade), `setTimeScale`, `setSeat(amount, seatHeight)`, `update(dt)`, `headTop`. |
| | `clipForState`, `walkTimeScale`, `seatPlacement` | Pure helpers: which clip for what a person does, feet speed for the ground speed, where a seated person sits. |
| `vehicles` | `loadVehicles(THREE, nodes)` | Cars from `office-cars.glb` by node name: `create(id)` gives a group sharing geometry and material. `advanceAlongLane(x, speed, dt, minX, maxX)` loops a driver. |

## Rules

* A failed download rejects the loader promise; the caller keeps its stand-ins (procedural people, box cars).
* The package never imports `src/` (checked by `tests/architecture`).
* Tests live in `packages/pixel-world/tests` (nav, batching, people helpers); the visual check is the local harness
  (`.bb/chats/<thread>/tmp/harness-engine`: `bash build.sh`, then serve it with the GLB folder and `node shot.mjs`).

## Not here yet

Chunk streaming and LOD for a city, `InstancedMesh` for repeated shapes (the office is boxes of all sizes; merging
was enough: ~2 900 draw calls became 21), interpolation of server plans for actors (phase 1B).
