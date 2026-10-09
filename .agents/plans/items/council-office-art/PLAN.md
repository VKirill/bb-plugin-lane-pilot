# Council office: art pass to match the owner's reference (bright isometric diorama room)

The owner compared the current office with a reference picture and wants it to look like the reference. Do this after council-office-qa-fixes (same files). Keep all behaviour (walking, sitting, gestures, bubbles, replay, layout) as is. This is a visual pass of the scene in src/rooms/council/ui/council-office.tsx; you may split the scene building into a new file src/rooms/council/ui/office-scene.ts.

## What the current scene looks like (screenshot from the owner, 2026-10-09)
- Dark navy void around and below the room. The room floor is near-black teal. The walls are flat grey-beige.
- A huge dark-brown block stands in the back corner (the bookshelf), out of scale.
- A big dark-red table. Three orange cubes with black boxes for desks/monitors. A dark grey cube with a red cube (the coffee counter).
- The camera is too close and crops the room. Lighting is dim. There are no outlines. Characters are blobs with mustard-yellow heads.

## Target (the reference, described)
Classic isometric pixel-art "cutaway diorama" room on a light/transparent background:
- **Room as an object.** A floor slab with visible thickness (side faces of the slab shown, like a cut-out block). Two walls only (back-left and back-right), with visible wall thickness on their top and front edges. The whole room fits in the frame with margin, centred. No dark void: the background is the page/card background (transparent clear color) or a very light neutral.
- **Palette.** Bright and warm. Left wall light peach (#fde8d7-ish), right wall pale yellow (#f8f3a6-ish), a dark grey baseboard/rail stripe along both walls at about 1/4 height, floor green carpet (#4f7a3a-ish) or light grey tiles, slab sides darker green/grey. The furniture is in light colours: an orange/wood long table top with dark legs, black office chairs, a light grey cabinet, white boards.
- **Outlines.** Pixel-art look with dark 1-px outlines. Render each mesh's silhouette and hard edges dark: EdgesGeometry LineSegments in a dark tone, or an outline pass via an inverted-hull back-face scaled mesh. They must stay crisp after the low-res upscale. Use flat shading with 2–3 tones per surface (top light, left mid, right dark). MeshLambert with a strong key light plus hemisphere/ambient light, or MeshBasic with face-tone colours. No dim scene.
- **Camera.** True isometric orthographic (yaw 45°, pitch ~30–35°), zoomed so the whole diorama including the slab edge is visible at every container size (fit on resize).
- **Props, at proper human scale:**
  - long meeting table in the centre with laptops (open screen + base, a few colours), a desktop monitor, papers, cups, a small speaker;
  - 6–8 black office chairs with a five-star base and wheels around it (the seats the characters use);
  - a projector screen on the left wall;
  - a whiteboard with scribbles (thin coloured line segments) on the right wall;
  - a glass double door on the right wall (translucent light-blue panels with frames);
  - a filing cabinet with drawers and items on top;
  - two green recycle bins;
  - a cardboard box with stuff;
  - a backpack, a guitar case or tall bag leaning on the wall;
  - a small fridge/PC tower;
  - cables on the floor;
  - a light switch.
  - Keep the coffee spot, the window and the plants from the behaviour spots, restyled to the same palette. Every wander spot from office-behaviour must still exist and be reachable (update the walk grid / blocked cells for the new furniture).
- **Characters.** Proper skin tone (not mustard), hair colours, a shirt in the seat colour, dark trousers, readable at the low internal resolution, with the same outline treatment. Scale them to the chairs and the table.
- **Labels and bubbles.** Keep the pixel style, but smaller name tags (about 9–10 px font) so they do not cover the scene.

## Performance and cleanliness
Merge static geometry where easy (BufferGeometryUtils.mergeGeometries per material) so that many props stay cheap. Dispose everything on unmount. The internal render resolution is still low and upscaled with `image-rendering: pixelated`, but high enough (≈ 1/2 of CSS size) for the details to read.

## Checks
- Typecheck, the council tests and the build pass. Pure helpers (walk grid with the new blocked cells, spots reachable) are covered in tests/council-office.test.ts: every wander spot and seat is reachable from every other.
- Save a screenshot of the new office from a local render to `.agents/plans/items/council-office-art/office.png` if you can run a browser. This is optional and not a check.

## Delivery
- [x] Bright outlined isometric cutaway office art and detailed props — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `47d3a36`.
