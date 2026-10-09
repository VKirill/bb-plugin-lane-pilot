# Council page: the office floor (with the director's office) is the desktop page; phones and tablets get the chat only (v2)

This redispatches the canceled council-office-desktop-floor; its writer went silent when the provider ran out of quota. Start from main.

## Source of truth (committed in e436990 and f229afd; read all of it before coding)
- `.agents/design/council-office/reference.jpg` is the target look: a 21:9 isometric pixel-art office floor with a big director's office on the right. Use it for STYLE only. Sizes and positions come from reference.md.
- `.agents/design/council-office/reference.md` is what to build:
  - the 40×20 tile grid with the ASCII map;
  - the rooms: back row meeting room 0–12, open space 12–26, director's office 26–40; a full-width corridor; front row lounge, kitchen, server room 21–28, entrance 28–40;
  - walls, doors and windows;
  - props per room with exact tiles: the 10 meeting chairs, the speaker spot, the director's office table of 31 props;
  - the palette;
  - the camera: orthographic, yaw 33°, pitch 30°, the floor projects to 1.95:1, plus the fit formula. Desktop only, no pan or zoom, pixel ratio 0.5;
  - lights and dark edge outlines;
  - §5 behaviour.
- `.agents/design/council-office/plan.png` is the top-down plan with the owner's spots H/W/B and the report spots R.
- `.agents/design/council-office/layout.md` and `wireframe.html` are the page layout. The office is shown at ≥1024 px only:
  - the canvas covers the whole block;
  - a floating 44 px top bar with the title, project select, council select replacing the list, state/round chip, replay controls and chat button;
  - the chat drawer docked on the right: 380 px at ≥1280, 340 px at 1024–1279; the camera fits the office into the space left of it;
  - when the drawer is closed, a small last-message card;
  - inside the drawer: decision pinned on top, agenda and participants behind disclosures, the feed, the composer.

  Below 1024 (§5) the page is a single-column chat page in the pixel style:
  - top bar, question, decision panel, «Повестка» / «Участники», feed (the only scrolling part), typing line, composer;
  - max 720 px on tablet;
  - tapping a seat in «Участники» highlights that seat's messages;
  - in replay, the cursor message is outlined and later messages are dimmed;
  - no canvas, and three.js is never loaded.

  Crossing 1024 on resize keeps the selected council, the replay cursor and the composer draft.
- Three.js skills on the machine: ~/.agents/skills/threejs-procedural-geometry, threejs-exposure-color-grading, threejs-camera-direction, threejs-procedural-animation, threejs-visual-validation. Read the SKILL.md of each one that fits.

## Decisions
1. **Desktop only**, as above. Dispose three.js when leaving desktop.
2. **Chat drawer starts collapsed** on desktop. Its state is remembered in localStorage.
3. **Rebuild the floor and positions from scratch** per reference.md. Replace the single-room scene in office-scene.ts and the old grid data in office-layout.ts and office-behaviour.ts. Keep the behaviour engine:
   - needs and activities with long durations;
   - reservations;
   - A* walking that never crosses footprints or other characters;
   - council gathering;
   - replay;
   - idle-after-pause;
   - the label collision resolver.

   Re-place every seat, desk, interaction point and wander spot on the 40×20 grid.
4. **The owner character:**
   - always on the floor, home is the director's chair; when idle he goes to the window or the bar;
   - council gathering does not move him;
   - he goes to the meeting room only while his own message is active (live) or under the replay cursor, at 3.5 tiles/s with his bubble following; he snaps on replay jumps, then walks home.
5. **Report visits:** council seats make short «report» visits (8–15 s) to the R spots, only while no council is live and no replay is playing.

## Keep
- Every existing data-testid: council-page, council-list, council-messages, council-composer, council-typing, council-replay-*, council-office.
- The composer behaviour, replay, the moderator notice and the WebGL fallback.
- No server or RPC changes. No downloaded assets.
- three.js is disposed on unmount.
- seatColor shirts and the chibi people.

## Checks
- tests/council-office.test.ts:
  - the 40×20 grid: every seat, desk, director-office spot (H/W/B) and report spot is reachable;
  - paths avoid footprints;
  - there are 10 meeting chairs;
  - the speaker spot is free;
  - the owner is present with no messages;
  - the owner stays home while the others gather;
  - the owner goes to the meeting room only on his own active or replayed message;
  - no report visits happen during a live council.
- tests/council-page.test.tsx: keep the old assertions and adjust selectors only where needed. Set the container width in jsdom to pick the view. Cover:
  - below 1024, no council-office element and the chat with the composer is visible;
  - at ≥1024, the drawer is collapsed by default with the latest message preview, and opening it shows the feed and the composer;
  - the council select replaces the list.
- Typecheck and build.

## Delivery
- [x] Rebuilt the desktop Council page as a full-block office floor with a director’s office and chat-only layout below 1024 px — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `5e578fe`.
