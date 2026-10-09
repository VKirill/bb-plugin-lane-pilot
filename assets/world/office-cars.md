# office-cars.glb

Seven stylised cars for the lot outside the council office (toy-like proportions, flat colours). Made from concept images (Gemini, cartoon toy-car style) -> Meshy image-to-3D (no rig, one textured mesh, about 40k triangles) -> low-poly bake in Blender 5.2 -> glTF, quantized with gltf-transform.

## Contents

- 0.93 MB, one GLB. Needs `KHR_mesh_quantization` (plain `GLTFLoader` supports it; no Meshopt/Draco decoder needed). The mesh node carries the scale/translation that undoes the quantization: keep the node transform when cloning.
- 7 roots, each one mesh, one material (`<name>_mat`: base colour 512x512 JPEG, roughness 1, metalness 0), no animation.
- Metres, ground at y = 0, centred on x/z, **front faces +Z**. The scene uses 1 unit = 1 m for cars (people are 1.4 m chibis x 1.25).

| node | model | triangles | length x width x height (m) |
|---|---|---|---|
| car_mustang | 1967 Ford Mustang fastback, red, white racing stripes | 2400 | 4.2 x 1.9 x 1.6 |
| car_raptor | Ford F-150 Raptor, dark grey, orange accents, big tyres | 2500 | 5.3 x 2.4 x 2.4 |
| car_911 | Porsche 911 (classic shape), yellow | 2399 | 4.2 x 2.0 x 1.5 |
| car_gwagon | Mercedes G-Class, black | 2200 | 4.2 x 2.1 x 2.1 |
| car_supercar | Lamborghini-style supercar, lime green | 2399 | 4.4 x 1.9 x 1.2 |
| car_cybertruck | Tesla Cybertruck, brushed steel | 1999 | 5.3 x 2.6 x 2.3 |
| car_vwbus | VW T1 bus, mint and white | 2400 | 4.5 x 1.9 x 2.2 |

## In the scene

`office-cars.ts` loads the GLB lazily (after the first frame), swaps the materials for the pixel pipeline's toon material (3-tone gradient, texture as emissive map like the people) and clones each car onto its spot (`CAR_SPOTS`): five in the south parking bays (tail to the kerb, nose to the street; the Raptor sticks out one metre past the bay line) and two on the east strip. The box cars of `office-props-b.ts` carry `userData.boxCar` and are hidden once the cars are in; they stay if the GLB cannot load. Two cars (`CAR_DRIVERS`, the 911 and the bus) loop slowly along the east-bound lane of the street (not with reduced motion).

## How it was made (to redo a car)

1. Concept: Gemini image model, prompt "... cute stylised toy-car cartoon look ... three-quarter front view from slightly above ... plain flat light grey background ... no text, no logos" (a first Raptor concept had "FORD"/"RAPTOR" lettering: asked again for no lettering).
2. `meshy.py concept.png outdir 4 --norig` (height argument goes before `--norig`). Takes 15-20 min for seven in parallel.
3. Meshy cars face -X in Blender: rotate 90 deg about Z so the front is -Y (= glTF +Z), scale the length, put the wheels on z = 0.
4. Metallic and coat are removed from the high-poly material before the bake (a metallic base colour bakes black). Cage extrusion 0.08 (0.03 smeared the angular Cybertruck with window colours).
5. The Raptor and the G-Wagon are voxel-remeshed (0.05 / 0.04 m) before decimation: their Meshy meshes are loose shells (floating wheels, interior) that the decimator cannot reduce. The G-Wagon texture is darkened x0.4 (Meshy bakes the sky reflection into the black paint).
6. Decimate to about 2.4k triangles, smooth shading with sharp edges above 30-55 deg, smart UV project (86 deg), bake base colour 1024 -> 512, saved as JPEG quality 70 with the **Standard** view transform (the default AgX washes the colours out).
7. `gltf-transform quantize` brings the file under 1 MB. The file is served as it is from `assets/world/` (src/rooms/world-assets/server), nothing is embedded in the bundle.
