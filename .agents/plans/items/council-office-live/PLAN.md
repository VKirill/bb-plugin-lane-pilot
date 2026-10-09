# Council pixel office (three.js) — the office IS the council page

Supersedes canceled task council-pixel-office (which had an Office/Chat toggle). If its worktree left partial files, start fresh from main.

## Why
The owner wants to *watch* a council: the seats are little pixel-art people in an office (references: isometric pixel-art offices with cubicles, meeting table, coffee corner, plants, windows, bookshelves) who come to the table and speak, turn to each other when they reply/argue, sit and wait while another seat speaks, and walk around randomly (coffee, window, plant, bookshelf) in free time. The owner was explicit: NO view toggle. The council page always shows the office, and the conversation history sits next to it, restyled as pixel art, so a finished council can be watched and read later.

## Data available (no server changes)
`get_council` returns `CouncilDetail` (see src/rooms/council/ui/council-page.tsx): `state` (terminal: done/failed/stopped), `round`, `maxRounds`, `speaking` (seat id or null), `speakingSince`, `agenda`, `seats[{id,title,providerId,model}]`, `messages[{seq,seatId,round,kind,text,at}]` with kind in agenda|position|reply|status|decision|owner, `recommendation`, `decisionPath`, `reason`. Speakers also include virtual seats `owner`, `chair`, `moderator`.

## Layout (one page, no toggle)
- Wide (>640 px): council list on the left as today (restyled pixel-art); main area = office canvas on top (~55% height, min 260 px) and the pixel-styled history log below it, composer at the bottom. If width allows (≥1100 px), office and history may sit side by side instead — writer chooses, both must stay readable.
- Compact (≤640 px): council select, office canvas at the top (~40vh, min 220 px), history log below scrolling, composer at the bottom.
- Header with the question and agenda stays, in pixel style, collapsible on compact as today.

## Pixel-art history log
Restyle the message feed as a retro game dialogue log, CSS only (no downloaded fonts or images): chunky 2–3 px stepped borders (box-shadow pixel border), flat palette matching the office, a small square pixel avatar per speaker in its office color, speaker name + round as a tag, the text still rendered by `Markdown` (readable font size; a monospace/pixel-ish font stack for labels only), owner/chair/moderator/decision visually distinct (decision as a highlighted panel), the `speaking` indicator as a blinking "▮ пишет…" line. Composer (input + Сказать / Решать / Стоп) restyled as pixel buttons, same behaviour.

## Linking history and office (watch later)
- Hover/click a message in the log → its speaker is highlighted in the office and shows that message's bubble.
- Replay: a «▶ Повтор» control (play, pause, step) plays the council from the first message: the office shows each message in turn (speaker walks to the table, bubble with its text start, the answered seat faced for replies, others waiting), and the log scrolls to and highlights the current message. Live councils follow the latest message by default; replay is available for any council. Replay is driven by a message cursor, not by the server.

## Code
1. `src/rooms/council/ui/office-behaviour.ts` — pure, no three.js, unit-tested. `deriveOfficeActors(detail, cursor, now)` where `cursor` is a message seq (null = live/latest): one actor per seat plus chair (and owner only when an owner message exists up to the cursor) with `id`, `label`, stable `color`, `activity`: `speaking` (live: detail.speaking === id; replay: author of the cursor message → goes to the meeting table, `bubble` = first ~80 chars of that message, or «…» while writing live), `arguing` (its message at the cursor in the current round is kind `reply` → `facing` = previous speaker), `waiting` (someone else speaks → sits at the table), `idle` (terminal council at live cursor, or no speaker for >20 s → wanders). `nextWanderTarget(rng, current, points)` with injectable rng. `seatColor(id)` exported and used by both log avatars and office characters.
2. `src/rooms/council/ui/council-office.tsx` — `CouncilOffice({ detail, cursor, highlightSeatId })`. Loads three.js lazily (`await import("three")` in an effect). OrthographicCamera isometric (~35° tilt, 45° yaw); room of low-poly boxes with flat colors (teal floor tiles, cream walls on two sides, window with blinds, door, wall board, bookshelf, cubicle desks with CRT monitors and chairs, central meeting table, coffee counter, plants). Pixel look: render at ~1/3 CSS resolution, upscale with `image-rendering: pixelated`, no antialias, flat materials. Characters: blocky voxel people colored per seat, walk with bob/leg swing, sit when waiting, gesture when speaking. Name labels and speech bubbles as HTML overlays projected each frame, styled like the log. requestAnimationFrame loop; `prefers-reduced-motion` → no wandering, static poses. ResizeObserver fits the canvas; unmount disposes renderer, geometries, materials and cancels the frame. No WebGL (jsdom) → text fallback, never throws.
3. `council-page.tsx`: always render the office + pixel log layout; keep all existing functions (council list, project select, composer, decision, reason, header). New strings (replay, pause, step, WebGL fallback) as i18n keys in packages/i18n/src/i18n.ts, en and ru.
4. Dependency: `three` in dependencies, `@types/three` in devDependencies (npm install, commit package-lock.json); `npm run build` must bundle it.

## Checks
- New `tests/council-office.test.ts`: deriveOfficeActors — live speaker gets `speaking` + bubble from its latest message; others `waiting`; reply → `arguing` facing previous speaker; terminal council at live cursor → all `idle`; replay cursor on an older message makes that message's author the speaker with that text; owner actor only when an owner message exists up to the cursor; seatColor stable; nextWanderTarget deterministic with a seeded rng and never returns `current`.
- tests/council-page.test.tsx: keep its existing assertions (messages, typing line, list, say on Enter, Решать) — adjust only selectors if markup changes; add cases: the office fallback renders in jsdom without throwing alongside the log; replay step highlights the first message in the log.

## Delivery
- [x] Always-on pixel-art office, linked history, and message-by-message replay — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `fbd36b2`.
