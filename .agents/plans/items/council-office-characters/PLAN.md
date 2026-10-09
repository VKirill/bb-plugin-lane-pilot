# Council office: believable characters (walking, sitting, talking, gestures)

Follow-up on accepted task council-office-live (same area page:council). Owner feedback: people teleport; they must walk like real people, sit at the table, visibly talk to each other with dialogue bubbles, gesture with their hands, and look more like characters.

## Root causes found in src/rooms/council/ui/council-office.tsx (verified by PM)
1. The three.js init effect depends only on `[detail.id]`, and `animate()` calls `deriveOfficeActors(detail, cursor, Date.now())` with the `detail` and `cursor` captured at init. Live updates and replay steps never reach the scene correctly, so state jumps when the scene is re-initialised. Fix: keep the latest `detail`, `cursor` and `highlightSeatId` in refs that the loop reads; init the scene once per mount/council only.
2. Movement is an exponential lerp (`currentPos += d * 0.08`) and snaps to the target below 0.05: very fast start and a hard snap look like teleporting, and it is frame-rate dependent. Fix: constant walking speed in units/second from a frame delta (clock), with acceleration and deceleration over the first and last ~0.3 units, turn toward the heading smoothly (slerp of the yaw, max turn rate) before and while walking, never set position directly except on first spawn.
3. Paths go in straight lines through the meeting table, desks and the counter. Fix: a small walk graph of waypoints around the furniture (or a coarse grid A* on the floor, ~0.5 unit cells, with furniture cells blocked). Characters follow the path point by point.
4. Seats: TABLE_SEATS has 8 entries and some overlap (z ±1.4 and ±1.5). Fix: distinct seats around the table, each with a visible chair mesh. A character walks to its chair, turns, and sits down with a short transition: legs rotate forward, body lowers onto the seat. Standing up is the reverse. No instant pose switch.
5. setScreenCoords runs every frame and re-renders React 60 times a second. Fix: update the overlay DOM nodes directly through refs (style.transform) in the loop. Keep React state for content only (bubble text, labels, highlight).
6. Characters have no arms. Fix: more character-like voxel people. Head with hair block (hair color/style varies per seat from a stable hash), eyes as two tiny dark boxes, shirt in the seat color, arms (upper arm + hand, pivot at the shoulder), legs with pivot at the hip, shoes. Still low-poly flat colors to fit the pixel style.

## Behaviour (driven by deriveOfficeActors; extend office-behaviour.ts if needed, keep it pure and tested)
- Speaking: stands up from its chair, steps beside it facing the table centre or the seat it answers. A talk gesture loop: one arm raises and moves, the other moves a little, the head nods. Speech bubble with the message start, which grows in with a short typewriter reveal; «…» with animated dots while writing live.
- Arguing (reply): faces the target and gestures more sharply (both arms, a pointing pose toward the target). The target turns its head toward the speaker.
- Waiting / listening: seated in its chair, small idle motions (head turns toward the current speaker, occasional arm move, shoulder breathing bob), with a random phase per character so they do not move in sync.
- Small reaction bubbles from listeners now and then (emoji-free pixel glyphs like «!», «?», «…» or a short «хм»), at most one at a time, only while someone speaks. They are purely decorative and never contain message text.
- Idle (council finished or no speaker >20 s): characters stand up and take a walk along the path graph to an office spot (coffee counter: pour/drink gesture; window: stand looking out; bookshelf: reach up; desk: sit at a cubicle chair and type with alternating arms; plant). They pause 3–8 s at each spot, sometimes two characters meet and face each other with small «…» bubbles. Choices use nextWanderTarget with a per-character rng. Two characters never target the same spot at once.
- Replay: each step makes the new speaker walk to its place and talk; the previous speaker goes back to its chair and sits; all motion is walked, never teleported. If the next replay step comes before a character arrives, it keeps walking from where it is.
- prefers-reduced-motion: no wandering; transitions become short fades between poses without walking; bubbles still appear.

## Constraints
- Keep the layout, log, replay controls, composer and everything else of the council page as accepted in council-office-live. Only the office scene and its overlay change, plus pure helpers in office-behaviour.ts.
- No server or RPC changes. No downloaded assets. Dispose all new geometries and materials on unmount.

## Checks
- Extend tests/council-office.test.ts with pure tests for the new helpers. Path finding never goes through blocked cells (table/desks/counter). The walk step moves at most speed×dt per frame and reaches the target without a jump. Seat assignment is unique per actor. The idle spot is never shared by two actors. The pose for each activity is right (sitting for waiting, standing+gesture for speaking, pointing toward the target for arguing).
- tests/council-page.test.tsx keeps passing.

## Delivery
- [x] Characters walk, sit, talk, gesture, and follow replay motion — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `3cb16ce`.
