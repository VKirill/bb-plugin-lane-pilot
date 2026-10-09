# Council page («Совет») — layout spec

Scope: `src/rooms/council/ui/council-page.tsx` (page shell) and the overlay part of `council-office.tsx` (tags, bubbles). The 3D floor itself is in `reference.md`. A clickable mock is in `wireframe.html`: open it in a browser and switch widths and drawer states with the buttons on top.

## 0. Principle

**Breakpoint: the office exists only when the content block is ≥ 1024 px wide** (from `useObservedWidth`, as today). Below 1024 there is no office at all: no canvas, no three.js import, no tags or bubbles. The page is the council chat only (§5).

**Desktop (≥ 1024): the office is the page.** It is a canvas that covers the **whole content block** (`position:absolute; inset:0`), with no card border, no grey band and no outer padding. Everything else floats above it (top bar, collapsed chat card) or sits beside it (the docked drawer). Speech bubbles over the characters are the main way to follow the talk. The chat is the archive and the input.

**Chat page (< 1024):** one column: top bar, header, decision, feed, composer. The same pixel kit and the same components as the desktop drawer, laid out as a page.

Load the office lazily: `council-office.tsx` (and three.js with it) is imported with `React.lazy` only when the block is ≥ 1024. Crossing the breakpoint on resize mounts or unmounts the office. The selected council, the replay cursor, the composer draft and the feed scroll position are kept.

What goes away from today's page:
* the `council-header` card (question + seat line): the question moves into the top bar's council picker and the drawer / chat header; the seat line moves into the «Участники» disclosure;
* the fixed 340/260 px office band;
* the 16rem `council-list` aside: it becomes the council select in the top bar;
* the always-open message log under the office: on desktop it moves into the drawer, and below 1024 it is the page.

Keep all existing `data-testid`s on the moved elements (`council-page`, `council-list`, `council-messages`, `council-composer`, `council-typing`, `council-replay-*`, `council-office`). `council-header` moves to the drawer / chat header. Add `council-drawer`, `council-drawer-toggle`, `council-peek` and `council-topbar`. `council-office` is rendered only at ≥ 1024.

## 1. Layers on desktop (bottom → top)

| z | Layer | Notes |
|---|---|---|
| 0 | Office canvas | fills the block; camera fit from `reference.md` §4 refits on every resize |
| 10 | Name tags, speech bubbles, reaction glyphs | HTML projected over the canvas (as today) |
| 20 | Moderator notice | top-centre under the top bar (today's notice, moved down 52 px) |
| 30 | Top bar | floating, pixel card |
| 30 | Collapsed chat card (peek) | bottom-right |
| 40 | Drawer | docked right |
| 50 | Menus | |

Pixel styling = the existing kit: `border-2 border-slate-900`, hard shadow `2px 2px 0 #0f172a`, `rounded-none`, `font-mono` for chrome, `bg-[var(--lp-card)]`. Overlays over the scene get `bg-[var(--lp-card)]/95` so the office shows through a little.

## 2. Top bar `council-topbar`

Desktop: a floating card, `top: 8px; left: 8px; right: 8px` (with the drawer open: `right: drawerWidth + 16`), height 44 px. Chat page: a normal (not floating) row at the top of the page, full width, height 44 px (48 px below 640), same card style. Contents left → right:

| Item | ≥ 1280 | 1024–1279 | 640–1023 (chat) | < 640 (chat) |
|---|---|---|---|---|
| Title `[ Совет ]` | yes | no | yes | no |
| Project select (`councilPick`) | select, max 14rem | select, max 10rem | select, max 12rem | inside the picker popover |
| Council select (`council-list`): option = `state · question` | select, flex 1, max 28rem | select, flex 1 | select, flex 1 | **picker button**: 1-line truncated question + ▾, opens a popover with the project select and the council list (radio rows, 2-line clamp) |
| State chip: `идёт · раунд 2/5` (`councilState_*`, `councilRound`, `round/maxRounds`); amber when live, green for `done`, red for `failed`/`stopped` | full | full | full | short `Р2/5` + colour dot |
| Replay ▶/⏸ ⏭ ⏹ | icon + text | icons | icon + text | icons, 40 px targets; ⏹ only while the cursor is set |
| Chat toggle `council-drawer-toggle`: `💬 12` (message count; a dot when unread) | yes | yes | no | no |

No second row at any width. With the drawer open the bar shortens, and the council select shrinks first.

## 3. Conversation drawer `council-drawer` (desktop only)

### Placement

| Block width | Size | Office |
|---|---|---|
| ≥ 1280 | **docked right**, 380 px, open by default | full height (top 8, bottom 8, right 8) |
| 1024–1279 | **docked right**, 340 px, open by default | same |

The canvas keeps `inset:0`. The camera fits into the **free area** (block width − drawer width − 16), so the drawer never covers the office. Pixel lever: `camera.setViewOffset` or a narrower fit width. The open/closed state is kept in `localStorage` (`lane-pilot:council:drawer`).

### Collapsed state (the latest message stays visible)

Card `council-peek` at bottom-right (right 8, bottom 8), 320 px wide. Contents: seat colour square, speaker name (bold mono uppercase 11 px), `· раунд N`, and the last message as 2 lines of plain text (markdown stripped). On the right: `💬 12 ›`. While someone is typing the line reads `▮ Скептик пишет…`. Click anywhere on the card to open the drawer. If a decision exists, the card shows a green `★ Решение` badge. With the drawer closed the office fits the full block width.

### Drawer contents (top → bottom)

1. **Header** (`council-header`): the question (bold mono 14 px, 3-line clamp, click expands), the state chip, a close button `✕`.
2. **Decision panel** (only when `recommendation` or `reason`): pinned under the header and **not** in the scroll. Emerald pixel card, `★ Решение`. Collapsed it shows 4 lines plus «Развернуть». Expanded it shows the full Markdown with a max height of 40 % of the drawer and its own scroll. `decisionPath` is shown in mono below. `reason` (failure) uses the red card in the same slot.
3. **Disclosures** (both collapsed, compact `Disclosure`): `Повестка (N)` (the agenda `<ol>`) and `Участники (N)` (per seat: colour square, title, `provider/model`; clicking a seat highlights the character in the office = `onSelectSpeaker`).
4. **Feed** (`council-messages`): flex 1, own scroll. Same message cards as today, but tighter: padding 8, speaker row 11 px, text 13 px. Clicking a message sets the replay cursor and highlights the speaker (as today). New messages auto-scroll only if the feed is already at the bottom; otherwise show a `↓ новые (3)` chip.
5. **Typing line** (`council-typing`), above the composer and outside the scroll.
6. **Composer** (`council-composer`): input on its own full row; below it 3 buttons in one row `Сказать` (amber, primary) · `Решать` · `Стоп` (rose). Enter sends. The composer shows only while the council is running; for a finished council it collapses into one muted line «Заседание закрыто».

## 4. Office overlays (in `council-office.tsx`, desktop only)

* **Name tags**: 9 px mono, bold, uppercase, 1 line, max 10 characters (ellipsis; full name in `title`), padding 1×4, background = seat colour, 1 px outline, no 2 px border. Shown for council seats + owner + chair. Hidden by default for ambient people, shown on hover.
* **Tag collision**: after projection, sort tags by screen y. If a tag's box overlaps an earlier one by more than 30 %, collapse it to the colour dot (the `data-collapsed=true` state that already exists). The speaker and the highlighted seat never collapse.
* **Speech bubble**: only the current speaker plus the cursor message in replay. Max width 220 px, 3-line clamp with the typewriter, a 6 px pixel tail pointing at the head, z above the other tags. Name line inside the bubble 9 px. Clicking the bubble opens the drawer and scrolls to that message.
* **Listener reactions** (`!`, `?`, `…`, `хм`) stay as they are.
* **Moderator notice**: top centre, 52 px below the top bar's bottom edge, max 360 px, 3 lines.
* No pan, no zoom, no recentre button: the camera is always the contain fit of `reference.md` §4.

## 5. Chat-only page (< 1024)

No office. The page is one column that fills the content block; the page itself does not scroll, only the feed does. On 640–1023 the column is max 720 px wide and centred, with 16 px side padding; on < 640 it is full width with 8 px padding.

Top → bottom:
1. **Top bar** (§2), not floating.
2. **Header** (`council-header`): the question (bold mono 14 px, 3-line clamp, tap expands) and the state chip. No close button.
3. **Decision panel**: the same emerald / red card as in the drawer, pinned (outside the feed scroll), collapsed to 4 lines with «Развернуть», expanded max 40 % of the page height with its own scroll.
4. **Disclosures** `Повестка (N)` and `Участники (N)`, collapsed. Tapping a seat in «Участники» highlights that seat's messages in the feed (2 px outline in the seat colour) and scrolls to its latest one; tap again to clear.
5. **Feed** (`council-messages`): flex 1, own scroll, the same message cards (padding 8, speaker row 11 px, text 13 px). `↓ новые (N)` chip as on desktop. In replay, the cursor message gets an amber outline and a `⏵ повтор` badge and is scrolled into view; messages after the cursor are dimmed to 40 %.
6. **Typing line** (`council-typing`).
7. **Composer** (`council-composer`), pinned at the bottom: input on its own row, then `Сказать` · `Решать` · `Стоп` in one row, buttons ≥ 40 px tall below 640. For a finished council, the line «Заседание закрыто». When the input is focused on a phone, the feed keeps its bottom in view (scroll to the end on focus; the composer stays above the keyboard via `100dvh` / `visualViewport`).

No peek, no drawer, no toggle and no moderator overlay: the moderator's notice is shown as a message card in the feed (muted, italic, no colour square).

## 6. Sizes

### 1280 × ~720 (drawer open)
```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│┌[ Совет ] [Проект ▾] [идёт · Стоит ли делить сервер… ▾] (идёт · раунд 2/5) ▶ ⏭ 💬12 ┐┌──────────────────┐│
│└────────────────────────────────────────────────────────────────────────────────┘│ Вопрос…        ✕ ││
│                                                                                   │ ★ Решение (4 стр)││
│        O F F I C E   F L O O R  (fit into 1280 − 396 = 884 px)                    │ ▸ Повестка (5)   ││
│        bubbles over heads, small tags                                             │ ▸ Участники (6)  ││
│                                                                                   │ feed …           ││
│                                                                                   │ ▮ Скептик пишет… ││
│                                                                                   │ [input         ] ││
│                                                                                   │ Сказать Решать Стоп│
└───────────────────────────────────────────────────────────────────────────────────┴──────────────────┘
```
With the drawer closed: the office fits the full 1280 and the peek card sits bottom-right.

### 1024 × ~700
Same as 1280 with a 340 px drawer; the office fits into 1024 − 356 = 668 px. The title `[ Совет ]` is hidden and the replay buttons are icons.

### 768 × ~900 (chat page)
```
┌──────────────────────────────────────────────┐
│[ Совет ] [Проект ▾] [идёт · Стоит ли… ▾] (идёт · раунд 2/5) ▶ Повтор ⏭ Шаг│
├──────────────────────────────────────────────┤
│        ┌──────── max 720, centred ───────┐   │
│        │ Стоит ли делить сервер…  (идёт) │   │
│        │ ★ Решение (4 стр) Развернуть    │   │
│        │ ▸ Повестка (5)  ▸ Участники (6) │   │
│        │ ┌ feed (scroll) ──────────────┐ │   │
│        │ │ ■ ВЛАДЕЛЕЦ  …               │ │   │
│        │ │ ■ СКЕПТИК · раунд 2  …      │ │   │
│        │ └─────────────────────────────┘ │   │
│        │ ▮ Архитектор пишет…             │   │
│        │ [input                        ] │   │
│        │ [Сказать] [Решать] [Стоп]       │   │
│        └─────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

### 375 × ~700 (chat page)
```
┌──────────────────────────────┐
│[Стоит ли делить… ▾] ●Р2/5 ▶ ⏭│  48 px top bar
├──────────────────────────────┤
│ Стоит ли делить сервер…      │
│ ★ Решение · Развернуть       │
│ ▸ Повестка  ▸ Участники      │
│ ┌ feed (scroll) ───────────┐ │
│ │ ■ СКЕПТИК · р.2          │ │
│ │ Я бы не делил сервер…    │ │
│ └──────────────────────────┘ │
│ ▮ Архитектор пишет…          │
│ [input                     ] │
│ [Сказать][Решать][ Стоп ]    │
└──────────────────────────────┘
```

## 7. States

| State | ≥ 1024 (office) | < 1024 (chat page) |
|---|---|---|
| No projects | Office with the empty floor (ambient people and the owner in his office). Top bar shows the project select disabled and the text `Проектов пока нет.` | Top bar as on the left; the body shows `Проектов пока нет.` centred |
| No councils | Office with ambient people. The council select is replaced by `councilEmpty` text (1 line, full text in `title`). No drawer, no peek | Top bar with the `councilEmpty` text; the body shows it centred. No feed, no composer |
| Live council | State chip amber and pulsing. Bubbles appear, and the peek updates with every message | Chip amber and pulsing; new messages appear in the feed |
| Finished | Chip green/red. Decision panel at the top of the drawer. The drawer opens once automatically when the decision arrives (not on later visits) | Chip green/red; the decision panel shows under the header |
| Replay | ⏹ visible. The cursor message bubble is over its speaker; the feed scrolls to the cursor; the peek shows the cursor message with a `⏵ повтор` badge | ⏹ visible; the cursor message is outlined and badged, later messages dimmed |
| No WebGL | Fallback card centred over a `#acddec` background; the drawer works as usual | not applicable |

## 8. New strings (en / ru) for `packages/i18n`

| Key | en | ru |
|---|---|---|
| `councilChat` | Chat | Чат |
| `councilChatClose` | Hide chat | Скрыть чат |
| `councilSeats` | Participants | Участники |
| `councilNewMessages` | new ({n}) | новые ({n}) |
| `councilClosed` | Session closed | Заседание закрыто |
| `councilExpand` | Expand | Развернуть |
| `councilReplayBadge` | replay | повтор |

## 9. Acceptance checks for the writer

1. At 1280×720 and 1024×700 the canvas element's box equals the content block (±1 px). No grey band, and the page itself does not scroll.
2. At 1280 and 1024 with the drawer open, the whole floor (grid 40×20, including the meeting room and the director's office) is inside the free area left of the drawer.
3. At 1023 and below there is no `council-office` element and no WebGL context, and the three.js chunk is not requested (network check).
4. At 768×1024 and 375×740: the feed is the only scrolling element, the composer is visible without scrolling, the composer buttons are ≥ 40 px tall at 375, and there is no horizontal scroll.
5. Resizing across 1024 keeps the selected council, the replay cursor and the composer draft.
6. With 8 seats seated (desktop), no two full name tags overlap (screenshot check).
7. Existing council-page tests keep passing with the same test ids.
