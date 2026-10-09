# Council office: rework after live browser QA (thr_t2d8egensw, lane-pilot 0.1.212)

Live check on bb.vechkasov.pro at 375, 768 and 1280 px. What passed: the layout, replay movement, bubbles (inside the office, plain text), pause, the moderator notice and the composer. Three things failed on every width.

## 1. Name labels overlap (high)
Measured label-box overlap:
- 1280 px: CHAIR×PRODUCT DIRECTOR 85%, OWNER×DEMAND DIRECTOR 85%, OWNER×AUDIENCE DIRECTOR 65%;
- 375 px: CHAIR×SKEPTIC 85%.

Fix: a per-frame label layout pass in screen space. Sort the labels by y and push a colliding label up or down in small steps until it no longer overlaps (with a max offset), and draw a thin leader line or tick to its character. When there are still collisions, show full labels only for the speaker and the highlighted actor; the others collapse to a small coloured square marker, and the full name shows on hover. Put the collision resolver in a pure helper (office-behaviour.ts) with tests: no two returned label rects overlap by more than 10%.

## 2. Characters freeze after a replay is paused (high)
Root cause (QA): in the replay branch of `deriveOfficeActors` in office-behaviour.ts (around line 685), a selected replay message always makes someone the speaker, so the others are always `waiting` and never `idle`. The 20 s idle timeout exists only in the live branch. They moved 0 px over 33 s after pause.

Fix: while a replay is paused, or when a message is only selected (not playing), apply the same idle rule after 20 s: everyone except the selected message's speaker becomes idle and wanders. When playback resumes, they walk back to their chairs. Unit test: cursor set + paused + 21 s elapsed means non-speakers are `idle`.

## 3. The art does not match the reference (high)
What QA saw: the walls are a uniform khaki/tan instead of peach and pale yellow, the floor renders dark olive, there is no visible baseboard stripe, and the room is tiny (about 240 px wide in a 642×224 frame at 1280). QA could not find the projector screen, the bins or the glass door, and could not read skin and hair.

Likely causes, to verify:
- Colour management: set the hex colours as sRGB. three ≥0.152 treats `Color` hex as sRGB by default with `ColorManagement.enabled`, but the renderer's outputColorSpace or lighting can darken them. Lambert with weak light turns peach into tan. Use MeshBasic/MeshLambert with per-face tone colours set explicitly (top = base, left = base×0.85, right = base×0.7), or raise the ambient/hemisphere light so the top faces render at their exact hex.
- Low internal resolution: render at 1/2 of the CSS size, not 1/3.
- Camera zoom: the orthographic frustum must fit the room's bounding box with about 8% margin in both axes, recomputed on resize. The room must fill the office frame.

Required visible result:
- walls #fde8d7 (left) and #f8f3a6 (right) as rendered pixels (±10% lightness on the shaded faces);
- a dark grey baseboard stripe on both walls;
- a green carpet floor of #5b8c3e-ish with a darker slab side;
- the projector screen (white, on the left wall), the glass double door (light-blue translucent with dark frames, on the right wall) and the two green bins, all clearly visible from the camera (not hidden behind walls or out of frame);
- characters with readable skin (#f1c27d-ish), hair and a shirt colour.

Make the office frame taller on wide layouts if it helps: at least 300 px at 1280×900, while the log keeps ≥160 px and the composer stays visible.

Add a pure test that the scene colour table contains these hex values, and keep `fitCamera(bounds, aspect)` as a pure helper with a test that the room's bounds fit inside the frustum.

## Keep
Everything that passed: layout, bubbles, replay, pause, moderator notice, composer, walking without jumps.

## Delivery
- [x] Fixed Council office label collisions, post-replay wandering, and reference-matching room art — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `c3d1605`.
