# Council office — reference for the three.js floor

Files in this folder:

| File | What it is |
|---|---|
| `reference.jpg` | **Target look** (3168×1344, ≈21:9). Variant A, chosen. |
| `plan.png` | Top-down plan drawn from the grid below. **Geometry comes from this file and this doc, not from the picture.** |
| `reference.jpg` | Same as reference.jpg |
| `variants/variant-b-meeting-centre.png` | Alternative: meeting room in the centre. Its floor is an irregular hexagon, which is harder to build and wastes width. Not chosen. |
| `variants/variant-c-flash.png` | Cheaper-model draft. The open space is cropped at the top. Not chosen. |
| `variants/prompt-a.txt` | Prompt used (Gemini 3 Pro Image, 21:9, 2K) |
| `layout.md`, `wireframe.html` | Page layout around the office |

**How to use the picture.** An image model drew it, so the perspective is not consistent: the glass walls and back walls slope differently, and the room proportions drift. Copy from the picture: the **style** (crisp dark outlines, flat two-tone shading, warm palette, chibi people), the **room set and their relative placement**, the **props**, and the **exterior lot** around the floor. Copy the **exact geometry** (sizes, doors, coordinates) from this doc.

Why variant A: it is a clean rectangle that maps onto one tile grid. All seven zones read at once. The meeting room is the biggest and brightest room, in the back-left corner where nothing occludes it. The floor fills the width, and grass, paving and sky fill the corners instead of a grey band.

---

## 1. Grid

* 1 tile = 1 world unit. The floor is **32 tiles along X × 20 tiles along Z**.
* Grid coords `(gx, gz)`: gx 0→32 from the left back wall to the right front edge, gz 0→20 from the back wall to the front edge.
* World = `x = gx − 16`, `z = gz − 10`, `y` up, floor top at `y = 0`. This replaces today's 20×14 `FLOOR_BOUNDS` in `office-layout.ts`.

```
     0         1         2         3
     01234567890123456789012345678901
z 0  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS     M meeting room (council)   12×11
z 1  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS     O open space                14×11
z 2  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS     S server room               6×9
z 3  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS     C corridor (2 deep, full width + nook 6×2)
z 4  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS     L lounge                    11×7
z 5  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS     K kitchen / coffee point    10×7
z 6  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS     E entrance / reception      11×7
z 7  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS
z 8  MMMMMMMMMMMMOOOOOOOOOOOOOOSSSSSS
z 9  MMMMMMMMMMMMOOOOOOOOOOOOOOCCCCCC
z10  MMMMMMMMMMMMOOOOOOOOOOOOOOCCCCCC
z11  CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
z12  CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
z13  LLLLLLLLLLLKKKKKKKKKKEEEEEEEEEEE
z14  LLLLLLLLLLLKKKKKKKKKKEEEEEEEEEEE
z15  LLLLLLLLLLLKKKKKKKKKKEEEEEEEEEEE
z16  LLLLLLLLLLLKKKKKKKKKKEEEEEEEEEEE
z17  LLLLLLLLLLLKKKKKKKKKKEEEEEEEEEEE
z18  LLLLLLLLLLLKKKKKKKKKKEEEEEEEEEEE
z19  LLLLLLLLLLLKKKKKKKKKKEEEEEEEEEEE
```

The open space has no wall to the corridor: the floor changes from carpet to vinyl, and three planters on gz 10.4 mark the edge. The entrance is also open to the corridor.

### Walls (on tile edges, grid coords)

| Wall | Type | Line | Span | Openings |
|---|---|---|---|---|
| North back wall | back, full height **3.5**, thick 0.3 | gz = 0 | gx 0–32 | windows gx 13–16, 17–20, 21–24 (sill 0.9, top 2.9); wall screen gx 4–8 (y 1.3–2.6) |
| West back wall | back, 3.5 | gx = 0 | gz 0–20 | windows gz 3–7 (meeting), gz 15–18 (lounge); whiteboard gz 7.5–10 (y 1.0–2.3) |
| Meeting east | **glass**, 2.6 high, white frame posts every 2 tiles | gx = 12 | gz 0–11 | none |
| Meeting south | **glass**, 2.6 | gz = 11 | gx 0–12 | glass double door **gx 8.5–10.5** |
| Server west | half wall **1.4**, thick 0.2 | gx = 26 | gz 0–9 | door **gz 6.25–7.75**: door frame 2.2 high, door leaf open 90° |
| Server south | half 1.4 | gz = 9 | gx 26–32 | none |
| Lounge north | half 1.4 | gz = 13 | gx 0–11 | doorway **gx 8.5–10.5** |
| Lounge / kitchen | half 1.4 | gx = 11 | gz 13–20 | none |
| Kitchen north | half 1.4 | gz = 13 | gx 11–21 | doorway **gx 11.5–13.5** |
| Kitchen / entrance | half 1.4 | gx = 21 | gz 13–20 | none |
| Front edge south | **stub 0.35** (cutaway) | gz = 20 | gx 0–32 | none |
| Front edge east | stub 0.35 | gx = 32 | gz 0–20 | **entrance**: glass double door gz 16–18, frame posts 2.4 high, no lintel wall |

Cutaway rule: only the north and west walls are full height. Every front-facing outer wall is a 0.35 stub. Interior walls stay at 1.4, so the rooms behind them stay visible at a 30° elevation (a 1.4 wall hides about 2.4 tiles behind it). Every wall top gets a dark cap (`outline`).

The floor slab is 0.5 thick. Its south and east sides show as a dark band (`slab side`), as in the picture.

---

## 2. Props per room (grid coords; footprint x0–x1 × z0–z1; h = height)

### Meeting room (the council sits here)
| Prop | Footprint | h | Notes |
|---|---|---|---|
| Long table | gx 2–10 × gz 4–6 | 0.95 | top slab 0.1 + 4 legs. Long side faces the camera |
| Chairs, north row | centres gx 3, 5, 7, 9 at gz 3.3, facing south | 0.9 | alternating teal / orange |
| Chairs, south row | centres gx 3, 5, 7, 9 at gz 6.7, facing north | 0.9 | alternating orange / teal |
| Head chair «chair» | centre gx 1.3, gz 5, facing east | 0.9 | slate `#64748b` cushion (seatColor chair) |
| Head chair «owner» | centre gx 10.7, gz 5, facing west | 0.9 | rose `#e11d48` cushion (seatColor owner) |
| Speaking spot | gx 6, gz 2.0, faces south (towards camera) | – | stands under the wall screen; replaces `pt_meeting_speak` |
| Wall screen | north wall gx 4–8 | – | dark bezel, blue chart |
| Whiteboard | west wall gz 7.5–10 | – | 6–8 sticky notes |
| Laptops ×2, papers ×3, mugs ×2 | on the table | – | as today |
| Plants | gx 0.6 gz 0.6 (big monstera), gx 11.4 gz 10.4 | 1.4 | terracotta pots |

10 chairs means up to 8 seats plus chair and owner. Today's `meeting_seat` points (`chair_m_*`) move to these centres. The moderator has no body and stays a wall-speaker notice.

### Open space (8 desks)
| Prop | Footprint | h | Notes |
|---|---|---|---|
| Desk cluster A | 4 desks 2×1: gx 14–16, 16–18 × gz 3–4 and 4–5 | 0.75 | back-to-back |
| Desk cluster B | gx 20–22, 22–24 × gz 3–4 and 4–5 | 0.75 | |
| Low divider | gz 4, gx 14–18 and gx 20–24 | 1.15 | teal-blue panel |
| Monitor + keyboard + lamp | one set per desk | 0.45 above top | screen glows `#77eaff` |
| Office chairs | gx 15, 17, 21, 23 at gz 2.4 (face south) and gz 5.6 (face north) | 0.9 | dark grey |
| Planters (corridor edge) | gx 13, 19, 25 at gz 10.4 | 1.2 | |
| Plant | gx 25.5 gz 0.6 | 1.4 | |

gz 6–10 stays free: people walk there, and this area is where long-activity people stand and chat.

### Server room
| Prop | Footprint | h |
|---|---|---|
| Server racks ×3 | gx 26.6–27.8, 28.0–29.2, 29.4–30.6 × gz 0.3–1.5 | 2.4, green/blue LED rows |
| Cable tray | along the north wall at y 2.8, gx 26.5–31.5 | posts down to each rack |
| AC unit | gx 31.0–31.8 × gz 6–7 | 1.0 |
| Printer | gx 27.0–28.2 × gz 7.2–8.2 | 0.9 (keeps `pt_printer`) |

### Corridor
Grey vinyl with a lighter edge strip. Plants at gx 0.6 gz 12 and gx 31.4 gz 12. Nothing else, so people can walk.

### Lounge
| Prop | Footprint | h |
|---|---|---|
| TV cabinet + TV on top | gx 2–5 × gz 13.2–13.8 | 0.5 + TV 0.7 |
| Bookshelf | gx 5.5–7 × gz 13.2–13.7 | 1.6 |
| Floor lamp | gx 1.0 gz 14.0 | 1.5 |
| Rug | gx 2–7 × gz 15–18 | flat |
| Coffee table | gx 3.5–5.5 × gz 16–17 | 0.4, magazines |
| Sofa A (3-seat), faces north | gx 2.5–6.5 × gz 18.2–19.2 | 0.8 |
| Sofa B (3-seat), faces west | gx 7.6–8.6 × gz 15–18 | 0.8 |
| Window-gaze spot | gx 1.0 gz 16.5, faces west | – |
| Plants | gx 0.6 gz 19.4, gx 10.4 gz 19.4 | 1.2 |

### Kitchen / coffee point
| Prop | Footprint | h |
|---|---|---|
| Counter with cabinets | gx 14–18 × gz 13.2–13.9 | 0.95; coffee machine at gx 14.5, sink at gx 16.5, cup stack at gx 17.5 |
| Fridge | gx 18.2–19.2 × gz 13.1–14.0 | 2.0 |
| Water cooler | gx 19.6–20.4 × gz 13.2–14.0 | 1.3, blue bottle |
| Bar island | gx 14–18 × gz 16–17 | 1.0, mug on top |
| Stools ×3 | gx 14.5, 16, 17.5 at gz 17.7 | 0.7 |
| Bin | gx 11.45 gz 19.45 | 0.5 |
| Plant | gx 20.4 gz 19.4 | 1.2 |

### Entrance / reception
| Prop | Footprint | h |
|---|---|---|
| Reception desk (faces east to the door) | gx 24–25 × gz 14–17 | 1.0, monitor on top |
| Coat stand with 2 coats | gx 31.25 gz 13.85 | 1.7 |
| Bench | gx 27.5–30.5 × gz 19.2–19.8 | 0.45 |
| Glass double door | east stub gz 16–18 | 2.4 |
| Doormat (outside) | gx 32–33.2 × gz 16–18 | flat |
| Plants | gx 31.4 gz 15.4, gx 31.4 gz 18.6, gx 21.6 gz 19.4 | 1.2 |
| Chat spot (2 people) | gx 28 gz 15 | keeps `pt_chat_entrance` |

### Exterior lot (fills the corners of the frame)
* A ground plane of **80×80** under the slab at `y = −0.5`, in grass. The camera never shows its edge.
* A paving path 3 tiles wide from the entrance door (gx 33–80, gz 15.5–18.5), and paving along the south edge (gz 21–23) running out of frame.
* Round trees (canopy is a 1.4 low-poly sphere or an octagon of boxes, trunk 0.3) at (−4, 6), (−3, 16), (8, 23), (26, 24), (36, 8), (40, 22). A street lamp at (35, 21). Small flower bushes along the slab edge.
* Scene background = `sky`. No fog.

---

## 3. Palette (hex)

Base colour = what the lit top face shows (use it as the material colour). The shade value is the colour the side face should land on with the lights below; use it to check the result. All lines and caps use `outline`.

### Global
| Surface | Base | Shade / detail |
|---|---|---|
| Outline (edges, wall caps, people) | `#282a36` | – |
| Slab side / foundation | `#413c42` | – |
| Sky (scene background) | `#acddec` | – |
| Grass | `#93c06b` | `#7aa858` tufts |
| Paving | `#c1bcc0` | joints `#8f8a92` |
| Tree canopy / trunk | `#81b352` / `#8a5a3c` | canopy shade `#5e8f3a` |
| Flowers | `#f6f0f6`, `#c58be0`, `#f48fb1` | – |
| Street lamp | post `#3a3d4a` | light `#f9e79f` |

### Walls per zone
| Zone | Wall face facing +X (lit) | Wall face facing +Z (shade) | Other |
|---|---|---|---|
| Meeting (back walls) | `#f7edd2` | `#e6cfaf` | baseboard `#c9a27a` |
| Meeting glass | glass `#cfe6ee` opacity 0.35 | – | frames `#f4f7f8`, diagonal highlight streaks `#ffffff` opacity 0.6 |
| Open space (north wall) | `#f7edd2` | `#e6cfaf` | windows: glass `#cdf1ff`, frame `#ffffff`, trees outside `#9fcf7a` |
| Server room walls | `#e8eef0` | `#cfd8dd` | door `#aee1f4` glass in `#e1e7ea` frame |
| Lounge / kitchen / entrance partitions | `#f9eed2` | `#e6cfaf` | top cap `#282a36` |
| Front stubs | `#e6cfaf` | `#d1b893` | cap `#282a36` |

### Floors per zone
| Zone | Base | Detail |
|---|---|---|
| Meeting | honey wood `#eab06e` | plank lines `#cf8f4f` every 0.5 tile |
| Open space | beige carpet `#dfb988` | speckle `#cba57a` |
| Server room | light raised floor `#c9d3d8` | 1-tile grid `#aab6bd` |
| Corridor + nook | grey vinyl `#bfccd4` | edge strip `#a9b8c2` |
| Lounge | warm wood `#e69d59` | plank lines `#c27e4a` |
| Kitchen | tile `#f0c8a2` | grout `#d9a982` every 1 tile |
| Entrance | warm wood `#e69d59` | plank lines `#c27e4a`; doormat `#8a6a4a` |

### Furniture
| Prop | Colours |
|---|---|
| Meeting table | top `#edb168`, edge `#c98a4a`, legs `#8a5a3c` |
| Chairs | cushion orange `#cb614b` / teal `#3e898e`; base `#3a3d4a` |
| Wall screen | bezel `#2f3340`, display `#2b4a6b`, chart `#4ade80` + `#38bdf8` |
| Whiteboard | board `#ffffff`, frame `#c0c6cc`, notes `#f9e05c` `#f48fb1` `#81d4fa` `#a5d6a7` |
| Desks | top `#e39f60`, side `#c27e4a`, legs `#b8bcc4` |
| Monitor | bezel `#3a3d4a`, screen `#77eaff` |
| Divider | `#6fa8b0` |
| Desk lamp | `#f0d27a` |
| Office chair | `#3a3d4a`, seat `#5b6070` |
| Server rack | body `#25252d`, face `#34343f`, LEDs `#4ade80` / `#38bdf8` |
| Cable tray | `#b8bcc4` |
| AC unit / printer | `#e8eef0`, grille `#9aa3ab` |
| Kitchen cabinets | `#f2e4c9`, doors `#e2cfae` |
| Counter / island top | `#e9a964` |
| Coffee machine | `#3d363e` |
| Fridge | `#c6d5da`, side `#a9bcc3` |
| Water cooler | body `#eef2f4`, bottle `#4dbfe1` |
| Stools | `#d98f5e` |
| Sofa | `#3e7f86`, shade `#2c626e` |
| Rug | `#dc9a5d`, pattern `#3e898e` + `#f2e4c9` |
| TV | body `#3d363e`, screen `#1f2430` |
| TV cabinet / coffee table | `#a8693f` |
| Bookshelf | `#805242`, books `#c3182a` `#3b82f6` `#64a83b` `#f0c419` |
| Floor lamp | shade `#f3e3b5`, pole `#3a3d4a` |
| Reception desk | body `#f2e4c9`, top `#e9a964` |
| Coat stand | `#8a5a3c` |
| Bench | `#de985d` |
| Entrance door | glass `#aee1f4`, frame `#e1e7ea` |
| Plants | leaf `#669e3b`, leaf shade `#518530`, pot `#ce6b4e` (or teal `#3e898e`), soil `#5a3d2b` |

### People (chibi, about 2 heads tall)
| Part | Colour |
|---|---|
| Shirt | `seatColor(seatId)` from `office-behaviour.ts` (owner `#e11d48`, chair `#64748b`, others from `SEAT_PALETTE`) |
| Skin | `#f2c39b`, `#c68a5e`, `#8d5a3a` (pick by seat index) |
| Hair | `#3a2a22`, `#f0c060`, `#6b3a1f` |
| Trousers / shoes | `#3a3d4a` / `#282a36` |

Size: 1.15 total height. Legs 0.4, torso 0.5×0.45×0.32, head a 0.42 cube with a hair cap 0.1. Outlined like the furniture.

---

## 4. Camera, light and pixel look

* `OrthographicCamera`. Direction from the target: **azimuth 33°** from +Z towards +X, **elevation 30°**. Offset = `R · (0.4716, 0.5, 0.7263)`, so with R = 60, camera at target + (28.3, 30.0, 43.6). This is the picture's view: the long north wall runs almost flat across the screen (slope ≈ 0.32) and the west wall drops steeper (≈ 0.77). Today's (12,14,12) 45° view cannot fill a wide block.
* Target = floor centre (0, 0, 0). The projected bounds of slab + back walls are **37.7 × 20.6 units (1.83:1)**, centred 1.3 units above the target on screen. Shift the frustum by that.
* **Fit = contain + 3 % padding**: `viewHeight = max(20.6, 37.7 / aspect) × 1.03`. A 1280×700 block (1.83) fits exactly. A 21:9 block shows the lot on both sides, and a tall block shows the lot above and below. No grey band at any size.
* Mobile (block narrower than 640): start at **cover-height** zoom (`viewHeight = 20.6 × 1.03`) centred on the meeting table (world −10, 0, −5). One-finger drag pans, pinch zooms (clamp 1×–2.5× of contain). A «⌖» button recentres.
* Light: `AmbientLight(#ffffff, 0.72)` + `DirectionalLight(#fff5ea, 0.45)` from direction (1.0, 2.0, 0.35), so tops are brightest, +X faces lit and +Z faces one step darker (the wall pair `#f7edd2` / `#e6cfaf` above). No shadows. `MeshLambertMaterial` only.
* Pixel look: `renderer.setPixelRatio(0.5)` on ≥ 768 (1 render pixel = 2 CSS px) and `0.75` below. Canvas CSS `image-rendering: pixelated`, `antialias: false`. HTML overlays (tags, bubbles) stay crisp on top.
* Outlines: `EdgesGeometry(geom, 30)` + `LineBasicMaterial(#282a36)` on every box and person. At pixel ratio 0.5 they come out as 2 CSS px lines, like the picture.

## 5. Out of scope for the scene
* No text or logos inside the 3D scene. Names, bubbles and the moderator notice stay HTML overlays (see `layout.md`).
* The WebGL fallback stays as today but sits on the `sky` colour instead of grey.
