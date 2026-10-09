# Council office: full-width office floor with several rooms + proper characters

Runs after council-office-rework: keep its label resolver, the idle-after-pause rule and fitCamera, and extend them.

## Owner request (2026-10-09, with a screenshot of the current page)
"Make the office full width; not a little square but a whole building, an office floor; build out the whole office space so the characters walk around it; and put the characters in order."

Current state from the screenshot: the office is a single square room in the left half of the page, with the history log in the right half. The characters are crude: square mustard/brown heads with no face, a flat body, labels floating far from them. The room shows a meeting table with chairs, a few desks, a whiteboard, a window and a cabinet.

## 1. Layout: office across the full width
- The office band spans the full width of the council page content (above the council list, the log and the composer), at about 50–55% of the page height on wide screens (min 320 px at 1280×900).
- Below the band: on wide screens the council list on the left and the history log with the composer on the right, as today; on compact (≤640 px) the council select, the log and the composer.
- At ≤640 px the band is about 45vh. The floor is wider than the screen, so allow horizontal drag/swipe panning, with the camera starting on the meeting room. Keep the bounded header (clamped question, agenda in a Disclosure).
- The log keeps at least 160 px and the composer stays fully visible at 1280×900, 768×900 and 375×812. No page scroll, no horizontal overflow.

## 2. A whole office floor (isometric cutaway, references: isometric pixel-art offices with several rooms)
Build a floor plan wider than deep (about 2.2:1) as a cutaway building: a thick floor slab with visible edge, exterior walls on the two back sides with windows, and interior walls cut at about 1/3 height so every room is visible from the camera. Rooms are connected by doorways and a corridor:
- **Meeting room** (the council's place, centre): long table, wheeled office chairs, projector screen, whiteboard, glass partition wall with a glass door.
- **Open space**: 6–8 workstations (desk, monitor, keyboard, office chair, small cubicle partitions, a few personal items). Each seat gets an assigned own desk.
- **Kitchen / coffee point**: counter with coffee machine, fridge, sink, bar stools or a small table, water cooler.
- **Lounge**: sofa, armchair, coffee table, TV on the wall, rug, plants.
- **Small server/print room**: server rack with blinking LEDs (emissive pixels toggling), a printer.
- **Entrance / reception**: door, a reception desk or coat stand, plants.
- **Floors**: different per zone (carpet in the open space, tiles in the kitchen, wood in the lounge).
- **Details**: windows on the exterior walls, baseboard stripe, ceiling lamps not needed.

Palette stays bright like the reference: light walls (peach / pale yellow / light blue per zone), dark crisp outlines, three-tone flat shading. Use merged or instanced geometry for repeated props (chairs, desks, monitors) so the floor stays fast. Render at half the CSS resolution with pixelated upscale. Dispose everything on unmount.

Walk graph: a grid A* over the whole floor, with walls and furniture blocked and doorways open. Update the pure helpers and tests: every seat, desk and wander spot is reachable from every other.

## 3. Characters "in order"
Replace the blocky mannequins with proper small pixel-art people (chibi proportions, about 1:2.5 head-to-body):
- **Head:** skin tone from a small varied palette, eyes (2 dark pixels with a blink every few seconds), a hair block in several styles (short, long, bun, bald, cap) and colours chosen per seat from a stable hash.
- **Body:** a shirt in the seat's colour with darker sleeves on the arms, hands in skin colour, dark trousers, shoes.
- **Accessories:** optional per seat (glasses, tie, headphones) for variety.
- **Animation:** a real walk cycle (alternate legs and arms, slight body bob). A proper sitting pose in chairs: thighs horizontal, sitting at the right height and facing the table/desk. Typing at a desk (alternating hands). Drinking coffee at the kitchen (cup in hand, raise to the mouth). Talking gestures in the meeting room. Pointing at the seat they argue with.
- **Name tags:** small (9–10 px), just above the head, following the character. They use the collision resolver from council-office-rework, so tags never overlap more than 10%.

## 4. Behaviour across the floor (extend office-behaviour.ts, keep it pure and tested)
- **Live council in session:** the seats sit at the meeting room table. The speaker stands and talks with a bubble, listeners react, as today.
- **Idle** (finished council, a paused replay after 20 s, or no speaker >20 s): each character picks activities across the whole floor. Go to its own desk and type, make coffee in the kitchen, sit on the lounge sofa, chat in pairs in the corridor with small «…» bubbles, look out of a window, check the server room. Stay 4–10 s at each, with a per-character rng and no two characters at one spot.
- **Replay:** characters walk from wherever they are back to the meeting room, and play proceeds as today.

## Checks
- tests/council-office.test.ts:
  - reachability over the new floor graph;
  - a desk is assigned to each seat;
  - idle activities pick spots across the different rooms;
  - spots are not shared.
- tests/council-page.test.tsx: the office band is rendered before the list/log row (full width). The existing assertions pass.
- Typecheck and build.

## Delivery
- [x] Expanded the Council scene into a full-width multi-room office floor with geodata-driven props and purposeful character activity — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `a4c3930`.
