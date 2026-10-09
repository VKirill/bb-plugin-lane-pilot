# Council office — reference for the three.js floor

Files in this folder:

| File | What it is |
|---|---|
| `reference.jpg` | **Target look** (2400×1018, ≈21:9). Variant «v5-extend-a», chosen: variant A's floor extended to the right with the director's office. |
| `plan.png` | Top-down plan drawn from the grid below (H/W/B/R mark the owner's spots and the report spots). **Geometry comes from this file and this doc, not from the picture.** |
| `layout.md`, `wireframe.html` | Page layout around the office |

The full-size PNG, the rejected variants, the prompts and the plan script are kept out of the repo, in the design chat's folder `.bb/chats/thr_d6zg57egme/artifacts/council-office-design/`. The full-size PNG is `reference.png` (3168×1344), and `director-variants/` holds `v1`–`v5`, the prompts `p1`–`p5`, `gen.py` (Gemini 3 Pro Image, 21:9, 2K) and `plan.py`. The first floor without the director's office is `variants/variant-a-chosen.png`.

**How to use the picture.** An image model drew it, so the perspective is not consistent: the glass walls and back walls slope differently, and the room proportions drift. Copy from the picture: the **style** (crisp dark outlines, flat two-tone shading, warm palette, chibi people), the **room set and their relative placement**, the **props**, and the **exterior lot** around the floor. Copy the **exact geometry** (sizes, doors, coordinates) from this doc. Known differences in the picture: the entrance blends into the front of the director's office and has no reception desk (the doc has a closed director's office and a separate entrance); the director's door sits on the side partition (the doc puts it on the corridor wall); only part of the second desk cluster shows.

Why v5-extend-a: of 7 tries (in `director-variants/`) it is the only one that kept every zone and all 8 desks while adding a rich director's office: walnut panelling, a double door, a bookshelf wall with statuettes, a panoramic window with a skyline, a credenza with a ship, a trophy and a model car, a bust, a globe, a Chesterfield corner, a bar with an espresso machine, and the owner at the desk. The others either replaced half the open space with the office (v1, v2), drifted in style (v3), or lost the lounge, kitchen or entrance (v4, v5-b).

---

## 1. Grid

* 1 tile = 1 world unit. The floor is **40 tiles along X × 20 tiles along Z** (it was 32×20; the director's office adds 8 tiles along X).
* Grid coords `(gx, gz)`: gx 0→40 from the left back wall to the right front edge, gz 0→20 from the back wall to the front edge.
* World = `x = gx − 20`, `z = gz − 10`, `y` up, floor top at `y = 0`. This replaces today's 20×14 `FLOOR_BOUNDS` in `office-layout.ts`.

```
     0         1         2         3
     0123456789012345678901234567890123456789
z0   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD     M meeting room (council)   12×11
z1   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD     O open space                14×11
z2   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD     D director's office        14×11  (owner)
z3   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD     C corridor (2 deep, full width 40)
z4   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD     L lounge                    11×7
z5   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD     K kitchen / coffee point    10×7
z6   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD     S server room               7×7
z7   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD     E entrance / reception      12×7
z8   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD
z9   MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD
z10  MMMMMMMMMMMMOOOOOOOOOOOOOODDDDDDDDDDDDDD
z11  CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
z12  CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
z13  LLLLLLLLLLLKKKKKKKKKKSSSSSSSEEEEEEEEEEEE
z14  LLLLLLLLLLLKKKKKKKKKKSSSSSSSEEEEEEEEEEEE
z15  LLLLLLLLLLLKKKKKKKKKKSSSSSSSEEEEEEEEEEEE
z16  LLLLLLLLLLLKKKKKKKKKKSSSSSSSEEEEEEEEEEEE
z17  LLLLLLLLLLLKKKKKKKKKKSSSSSSSEEEEEEEEEEEE
z18  LLLLLLLLLLLKKKKKKKKKKSSSSSSSEEEEEEEEEEEE
z19  LLLLLLLLLLLKKKKKKKKKKSSSSSSSEEEEEEEEEEEE
```

The open space has no wall to the corridor: the floor changes from carpet to vinyl, and three planters on gz 10.4 mark the edge. The entrance is also open to the corridor. The director's office is the one closed room in the back row: walnut half walls on its west and south sides, and a door to the corridor. The server room moved from the back-right corner to the front row, between the kitchen and the entrance.

### Walls (on tile edges, grid coords)

| Wall | Type | Line | Span | Openings |
|---|---|---|---|---|
| North back wall | back, full height **3.5**, thick 0.3 | gz = 0 | gx 0–40 | windows gx 13–16, 17–20, 21–24 (sill 0.9, top 2.9); **panoramic window gx 30.4–39.6** (sill 0.6, top 3.2, 6 panes, mullions every 1.53, see §2 Director's office); wall screen gx 4–8 (y 1.3–2.6) |
| West back wall | back, 3.5 | gx = 0 | gz 0–20 | windows gz 3–7 (meeting), gz 15–18 (lounge); whiteboard gz 7.5–10 (y 1.0–2.3) |
| Meeting east | **glass**, 2.6 high, white frame posts every 2 tiles | gx = 12 | gz 0–11 | none |
| Meeting south | **glass**, 2.6 | gz = 11 | gx 0–12 | glass double door **gx 8.5–10.5** |
| Director west | half wall **1.4**, thick 0.2, **walnut panelling** on both faces | gx = 26 | gz 0–11 | none |
| Director south | half 1.4, walnut panelling | gz = 11 | gx 26–40 | **double door gx 33.8–35.8**: walnut leaves with brass handles, frame posts 2.4 high plus a 0.3 cornice over the opening; both leaves open inwards 90° (they stand along gx 33.8 and 35.8 between gz 10 and 11) |
| Lounge north | half 1.4 | gz = 13 | gx 0–11 | doorway **gx 8.5–10.5** |
| Lounge / kitchen | half 1.4 | gx = 11 | gz 13–20 | none |
| Kitchen north | half 1.4 | gz = 13 | gx 11–21 | doorway **gx 11.5–13.5** |
| Kitchen / server | half 1.4 | gx = 21 | gz 13–20 | none |
| Server north | half 1.4 (server wall colours) | gz = 13 | gx 21–28 | door **gx 26.0–27.5**: frame 2.2 high, glass leaf open 90° |
| Server / entrance | half 1.4 | gx = 28 | gz 13–20 | none |
| Front edge south | **stub 0.35** (cutaway) | gz = 20 | gx 0–40 | none |
| Front edge east | stub 0.35 | gx = 40 | gz 0–20 | **entrance**: glass double door gz 16–18, frame posts 2.4 high, no lintel wall |

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

### Director's office (the owner's cabinet, seat `owner`)
The richest room on the floor: 14×11 (154 tiles; the meeting room is 132, the lounge 77, the server room 49). Floor: walnut parquet. Walls: walnut panelling on the two half walls; the north back wall stays cream around the panoramic window. Everything below is in grid coords; `+h` means it stands on the prop below.

| # | Prop | Footprint / centre | h | Notes |
|---|---|---|---|---|
| 1 | **Panoramic window** | north wall gx 30.4–39.6 | sill 0.6, top 3.2 | 6 panes, white mullions every 1.53, diagonal highlight streaks; behind the glass a flat backdrop of skyline blocks and tree tops |
| 2 | **Executive desk** | gx 32.8–36.8 × gz 3.0–4.4 | 0.8 | walnut, front modesty panel faces south (towards the door and the camera), 4 brass ball feet |
| 3 | **Director's leather chair** (high back) | centre gx 34.8, gz 2.25, 0.9×0.8, faces south | seat 0.5, back 1.35 | tufted brown leather, brass studs. **Home point of `owner`** |
| 4 | Guest chairs ×2 (leather) | centres gx 33.8 and 35.8, gz 5.3, 0.75×0.75, face north | back 1.0 | walnut frame, leather seat |
| 5 | **Vintage desk lamp** (banker's lamp) | gx 33.3, gz 3.35 on the desk | +0.45 | brass stem, green glass shade, emissive `lamp glow` |
| 6 | Laptop | gx 34.55–35.05 × gz 3.4–3.7 on the desk | +0.25 open | silver, screen `#77eaff` |
| 7 | Gold «thinker» figurine | gx 34.0, gz 3.95 on the desk | +0.22 | gold |
| 8 | Framed photo | gx 36.2, gz 3.35 on the desk | +0.2 | gold frame, faces north (towards the chair) |
| 9 | Papers + pen set | gx 35.8–36.2 × gz 3.85–4.15 | flat | |
| 10 | **Credenza** under the window | gx 31.6–38.0 × gz 0.3–0.9 | 0.75 | walnut, 4 doors, brass handles |
| 11 | **Model sailing ship** | on the credenza, gx 32.2–33.4 × gz 0.45–0.75 | +0.6 | hull wood, 3 masts, cream sails, small stand |
| 12 | **Trophy cup** (award) | on the credenza, gx 35.4, gz 0.6 | +0.55 | gold cup on a black base |
| 13 | **Model car** (red vintage) | on the credenza, gx 36.6–37.4 × gz 0.45–0.75 | +0.2 | red body, chrome bumper |
| 14 | **Bookshelf wall**: 3 built-in units | against the west wall, gx 26.15–26.75 × gz 0.6–2.4, 2.4–4.2, 4.2–6.0, face east | 2.4 | walnut; closed doors on the bottom 0.8; 4 shelves of books (book colours as the lounge bookshelf plus `leather` and `brass`) |
| 15 | Bronze horse statuette | middle unit, shelf y 1.6, gx 26.45, gz 3.1 | 0.35 | bronze |
| 16 | Crystal award (obelisk) | middle unit, shelf y 1.1, gx 26.45, gz 3.6 | 0.3 | crystal, opacity 0.8 |
| 17 | Jade elephant figurine | south unit, shelf y 1.6, gx 26.45, gz 5.1 | 0.25 | jade |
| 18 | **Marble bust on a pedestal** | pedestal gx 28.7–29.3 × gz 0.4–1.0 | pedestal 1.0 + bust 0.5 | marble column, classical head |
| 19 | Gold-framed painting | north wall gx 28.0–30.0, y 1.8–2.9 | – | landscape canvas |
| 20 | **Framed diplomas** ×2 | north wall gx 26.95–27.65, y 1.45–1.95 and y 2.15–2.65 | – | cream paper, walnut frame, red seal dot |
| 21 | **Floor globe** on a stand | centre gx 38.9, gz 1.7, radius 0.4 | 1.1 (ball 0.6 on a 3-leg stand + brass meridian ring) | antique parchment ocean, olive land |
| 22 | **Persian rug** under the desk | gx 31.8–37.8 × gz 1.6–6.6 | flat | burgundy field, gold border 0.2 wide, dark inner medallion |
| 23 | Sitting-corner rug | gx 26.6–31.6 × gz 6.3–9.8 | flat | olive-brown |
| 24 | **Chesterfield leather sofa** (3-seat) | gx 27.6–30.6 × gz 6.6–7.5, faces south | 0.85 | tufted brown leather, rolled arms |
| 25 | Leather armchairs ×2 | gx 26.5–27.4 × gz 8.0–8.9 (faces east); gx 30.8–31.7 × gz 8.0–8.9 (faces west) | 0.85 | same leather |
| 26 | Coffee table | gx 28.4–29.8 × gz 8.0–8.8 | 0.4 | walnut, a book and a small succulent on top |
| 27 | **Mini bar / coffee corner** counter | gx 36.6–39.4 × gz 7.6–8.4 | 1.05 | walnut body, polished top, **brass foot rail** on the south face (gz 8.4–8.5, y 0.15) |
| 28 | On the bar: decanter, 3 bottles, 2 glasses | decanter gx 37.0 gz 8.0; bottles gx 37.5, 37.8, 38.1 at gz 8.0; glasses gx 38.45 at gz 7.85 / 8.15 | +0.35 / +0.3 / +0.12 | decanter glass with red liquid, amber and green bottles |
| 29 | Espresso machine | on the bar, gx 38.8–39.3 × gz 7.7–8.3 | +0.4 | dark body, brass details |
| 30 | **Big plants** ×3 in brass pots | fiddle-leaf fig gx 39.3 gz 0.6 (h 1.9); bird of paradise gx 39.3 gz 5.6 (h 1.6); monstera gx 32.4 gz 10.3 (h 1.6) | | brass pots instead of terracotta |
| 31 | Door plants ×2 (corridor side) | gx 33.2 and 36.4, gz 11.45, radius 0.3 | 1.3 | brass pots, they frame the door from the corridor |

Interaction points (new; `assignedTo: "owner"` means nobody else may reserve them):

| id | Where (grid) | Faces | Pose | Use |
|---|---|---|---|---|
| `pt_director_chair` | gx 34.8, gz 2.25 | south | `typing` (seated at a desk) | owner's home; `assignedTo: "owner"` |
| `pt_director_window` | gx 30.4, gz 1.1 | north (back to the camera) | `window_gaze` | owner only |
| `pt_director_bar` | gx 38.0, gz 7.0 (behind the bar, north side) | south | `drinking` | owner only |
| `pt_director_report_1`, `_2` | gx 34.3 and 35.3, gz 11.9 (corridor, in front of the door) | north | `chatting` | council seats, «report» activity, capacity 1 each |

Walking line inside the office: from the door (gx 33.8–35.8) straight north to the guest chairs, then around the east end of the desk (gx 37.0–37.4) to the chair. Keep gx 33.0–36.4 × gz 5.7–11 and gx 36.9–37.5 × gz 1.0–7.4 free of props.

Occlusion check: the 2.4-high bookshelf hides the open-space floor at about gx 24–26 × gz 0–2.5 (only the plant at gx 25.5 gz 0.6, which may move to gx 24.6). The south half wall hides the office floor at gz 8.6–11, so the sofa corner sits at gz 6.3–9.8: the seat backs and the coffee table stay visible.

### Server room (moved to the front row)
| Prop | Footprint | h |
|---|---|---|
| Server racks ×3, faces south | gx 21.6–22.8, 23.0–24.2, 24.4–25.6 × gz 13.3–14.5 | 2.2, green/blue LED rows |
| Cable tray | along the north wall at y 2.4, gx 21.5–25.8 | posts down to each rack |
| AC unit | gx 26.8–27.6 × gz 18.6–19.6 | 1.0 |
| Printer | gx 22.0–23.2 × gz 18.4–19.4 | 0.9; `pt_printer` at gx 22.6 gz 17.8, faces south |

The racks rise above the 1.4 north wall and hide a strip of corridor floor behind them; nothing interactive stands there.

### Corridor
Grey vinyl with a lighter edge strip. Plants at gx 0.6 gz 12 and gx 39.4 gz 12, plus the two brass-pot plants at the director's door (gx 33.2 and 36.4, gz 11.45). Nothing else, so people can walk.

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

### Entrance / reception (shifted right: now gx 28–40)
| Prop | Footprint | h |
|---|---|---|
| Reception desk (faces east to the door) | gx 31–32 × gz 14–17 | 1.0, monitor on top |
| Coat stand with 2 coats | gx 39.25 gz 13.85 | 1.7 |
| Bench | gx 35.5–38.5 × gz 19.2–19.8 | 0.45 |
| Glass double door | east stub gz 16–18 | 2.4 |
| Doormat (outside) | gx 40–41.2 × gz 16–18 | flat |
| Plants | gx 39.4 gz 15.4, gx 39.4 gz 18.6, gx 28.6 gz 19.4 | 1.2 |
| Chat spot (2 people) | gx 35 gz 15 | keeps `pt_chat_entrance` |

### Exterior lot (fills the corners of the frame)
* A ground plane of **100×100** under the slab at `y = −0.5`, in grass. The camera never shows its edge.
* A paving path 3 tiles wide from the entrance door (gx 41–90, gz 15.5–18.5), and paving along the south edge (gz 21–23) running out of frame.
* Round trees (canopy is a 1.4 low-poly sphere or an octagon of boxes, trunk 0.3) at (−4, 6), (−3, 16), (8, 23), (30, 24), (44, 6), (48, 22) (grid coords). A street lamp at (43, 21). Small flower bushes along the slab edge.
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
| Director half walls (walnut panelling) | `#7a4a2e` | `#5e3721` | raised panels `#8a5a3c` with groove lines `#4a2a18`; top cap `#282a36`; brass trim line at y 1.3 `#d4a537` |
| Director door | leaves `#6b4029`, panels `#7b4a2e` | `#55321f` | handles `#d4a537`; frame + cornice `#5e3721` |
| Director panoramic window | glass `#cdf1ff` opacity 0.55 | – | mullions `#ffffff`; backdrop skyline `#9fb3c8` / `#b8c8d8`, tree tops `#9fcf7a` |
| Front stubs | `#e6cfaf` | `#d1b893` | cap `#282a36` |

### Floors per zone
| Zone | Base | Detail |
|---|---|---|
| Meeting | honey wood `#eab06e` | plank lines `#cf8f4f` every 0.5 tile |
| Open space | beige carpet `#dfb988` | speckle `#cba57a` |
| Director's office | walnut parquet `#b9774a` | straight plank lines `#8f5532` every 0.5 tile |
| Server room | light raised floor `#c9d3d8` | 1-tile grid `#aab6bd` |
| Corridor | grey vinyl `#bfccd4` | edge strip `#a9b8c2` |
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

#### Director's office (shared tokens)
| Token | Base | Shade / detail | Used for |
|---|---|---|---|
| `walnut` | `#7b4a2e` | `#5e3721` | executive desk, credenza, bar body, coffee table, bookshelf units (body `#6b4029`) |
| `walnut top` | `#8f5a38` | edge `#6b4029` | desk / credenza / bar tops (polished) |
| `leather` | `#7a3b22` | `#5c2a17`; tufting dots `#4a2112` | sofa, armchairs, guest chairs |
| `leather dark` | `#6e3420` | `#4f2416`; studs `#d4a537` | director's chair |
| `brass` | `#d4a537` | `#a87b1f`; highlight `#f2d37a` | handles, foot rail, trims, lamp stem, plant pots, globe ring |
| `gold` | `#e8b923` | `#b88a14`; highlight `#fff0a8` | trophy cup, thinker figurine, painting frame |
| `bronze` | `#b08d57` | `#7d5f33` | horse statuette |
| `marble` | `#eceae4` | `#c9c5bb` | bust and pedestal |
| `crystal` | `#bfe9ff` | `#8fcbe8` | crystal award (opacity 0.8), glasses |
| `jade` | `#4f9a7a` | `#3a7a5e` | elephant figurine |
| `rug burgundy` | `#8e2b3a` | inner `#6e1f2c`; border `#d4a537`; medallion `#3e898e` | Persian rug |
| `rug olive` | `#7a7046` | border `#5e5636` | sitting-corner rug |
| `lamp glow` | shade `#2f8f4e` | emissive `#9be7b0` 0.4 | banker's lamp |
| `globe` | ocean `#c9b98a` | land `#8a9a5b`; stand `#5c3a24` | floor globe |
| `ship` | hull `#8a5a3c` | sails `#f4ead2`, masts `#5c3a24` | model ship |
| `car red` | `#c3262e` | `#8f1b22`; chrome `#d9dde2` | model car |
| `bottles` | amber `#b5651d`, green `#3f6e3a` | decanter glass `#e3f1f5` with `#9b2d30` | mini bar |
| `paper` | `#f4ead2` | seal `#c3182a` | diplomas, papers |
| `canvas` | `#9fcf7a` | sky `#f0c070` | painting |

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
* Target = floor centre (0, 0, 0) (= grid gx 20, gz 10). The projected bounds of slab + back walls are **44.4 × 22.7 units (1.95:1)** for the 40×20 floor (were 37.7 × 20.6 for 32×20), centred 1.3 units above the target on screen. Shift the frustum by that.
* **Fit = contain + 3 % padding**: `viewHeight = max(22.7, 44.4 / aspect) × 1.03`. A 1280×656 block (1.95) fits exactly. A 21:9 block shows the lot on both sides, and a tall block shows the lot above and below. No grey band at any size.
* Mobile (block narrower than 640): start at **cover-height** zoom (`viewHeight = 22.7 × 1.03`) centred on the meeting table (world −14, 0, −5). One-finger drag pans, pinch zooms (clamp 1×–2.5× of contain). A «⌖» button recentres.
* Light: `AmbientLight(#ffffff, 0.72)` + `DirectionalLight(#fff5ea, 0.45)` from direction (1.0, 2.0, 0.35), so tops are brightest, +X faces lit and +Z faces one step darker (the wall pair `#f7edd2` / `#e6cfaf` above). No shadows. `MeshLambertMaterial` only.
* Pixel look: `renderer.setPixelRatio(0.5)` on ≥ 768 (1 render pixel = 2 CSS px) and `0.75` below. Canvas CSS `image-rendering: pixelated`, `antialias: false`. HTML overlays (tags, bubbles) stay crisp on top.
* Outlines: `EdgesGeometry(geom, 30)` + `LineBasicMaterial(#282a36)` on every box and person. At pixel ratio 0.5 they come out as 2 CSS px lines, like the picture.

## 5. Behaviour: the owner and the director's office

Today `deriveOfficeActors` (`office-behaviour.ts`) adds the `owner` body only after the owner has written in the council, and `stepOfficeSimulation` (`office-layout.ts`) sends everyone to a meeting seat while a council is active. With the office, the rules change as follows.

### The `owner` character
* **Always on the floor.** He is drawn on every council page (also with no owner messages, also for the empty floor), with his tag (`seatColor("owner")`, rose shirt) and the same chibi body as everyone else.
* **Home = the director's chair** `pt_director_chair`. He spawns there, seated at the desk (`typing` pose, laptop open), and returns there after every errand. He never uses the open-space desks, the kitchen, the lounge sofas or the corridor chat spots, and nobody else may reserve his points (`assignedTo: "owner"`).
* **Idle loop** (no owner message active): chair 90–240 s → then a weighted pick: 60 % stay at the chair for another round, 25 % `pt_director_window` for 15–30 s (`window_gaze`, back to the camera, looking at the skyline), 15 % `pt_director_bar` for 20–40 s (`drinking`: pours, sips) → back to the chair. He does not leave the office in the idle loop.
* **The meeting room only when he speaks.** The council-active override does **not** apply to him. He walks to the meeting room only when:
  1. **live**: the owner's message is the active one (the latest message is his, or the composer has just sent one), or
  2. **replay**: the replay cursor is on one of his messages.
  
  Then he walks from the chair → office door (gx 34.8, gz 10.5) → corridor west along gz 12 → meeting glass door (gx 9.5, gz 11) → head chair «owner» (gx 10.7, gz 5, faces west) and plays `speaking` / `arguing` like any seat. The route is ≈ 41 tiles: he walks at **3.5 tiles/s** («hurry»; the others use `WALK_SPEED` 2.0), so it takes about 12 s. His bubble is shown from the moment the message becomes active and follows his head while he walks. In replay, if the cursor moves on before he arrives, or the user jumps (⏭, clicking a message), he snaps to the target point instead of walking.
* **Going back.** He stays in his meeting chair while any of the next 2 messages after his is a `reply` facing him, then for 15 s more. Once no owner message has been active for 15 s (live) or the replay cursor leaves his messages and is not on a reply to him, he walks back to `pt_director_chair` at the normal speed of 2.0. If a council ends (`done` / `failed` / `stopped`), he goes home too.
* Clicking his tag or his seat line in «Участники» highlights him wherever he is, as for any seat (`onSelectSpeaker`).

### «Report» visits by council seats
* A new short activity for council seats (not the moderator, not `chair`, not ambient people): `report`. The seat walks to a free `pt_director_report_1` / `_2` in the corridor in front of the director's door, stands facing north (`chatting` pose, a small `…` or `!` reaction over the head) for **8–15 s**, then goes back to its previous point.
* Only while the owner is at home in the office (not walking, not in the meeting room). While a council is active, a seat may report only when it is not the speaker, not the next speaker, and not addressed by the latest `reply`. At most one report per seat per 3 minutes, and at most 2 at once (one per point).
* Weight: in the ambient loop after a desk stint, `report` takes 10 % (taken from the «window» share: coffee 35 %, sofa 30 %, window 10 %, chat 15 %, report 10 %).
* When the owner leaves for the meeting room, any seat standing at a report point leaves at once (yields the door).
* Visitors never enter the office; the door leaves stay open, the office is the owner's.

`AgentActivity` gets `report`, and `InteractionPointKind` gets `director_chair`, `bar` and `report`. Reuse the existing poses. `ZoneKind` gets `director`.

## 6. Out of scope for the scene
* No text or logos inside the 3D scene. Names, bubbles and the moderator notice stay HTML overlays (see `layout.md`).
* The WebGL fallback stays as today but sits on the `sky` colour instead of grey.
