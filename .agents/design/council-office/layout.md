# Council page («Совет») — layout spec

Scope: `src/rooms/council/ui/council-page.tsx` (page shell) and the overlay part of `council-office.tsx` (tags, bubbles). The 3D floor itself is in `reference.md`. A clickable mock is in `wireframe.html`: open it in a browser and switch widths and drawer states with the buttons on top.

## 0. Principle

The office is the page. It is a canvas that covers the **whole content block** (`position:absolute; inset:0`), with no card border, no grey band and no outer padding. Everything else floats above it (top bar, collapsed chat card) or slides over or beside it (drawer, bottom sheet). Speech bubbles over the characters are the main way to follow the talk. The chat is the archive and the input.

What goes away from today's page:
* the `council-header` card (question + seat line): the question moves into the top bar's council picker and the drawer header; the seat line moves into the drawer's «Участники» disclosure;
* the fixed 340/260 px office band;
* the 16rem `council-list` aside: it becomes the council select in the top bar;
* the always-open message log: it moves into the drawer.

Keep all existing `data-testid`s on the moved elements (`council-page`, `council-list`, `council-messages`, `council-composer`, `council-typing`, `council-replay-*`, `council-office`). `council-header` moves to the drawer header. Add `council-drawer`, `council-drawer-toggle`, `council-peek` and `council-topbar`.

## 1. Layers (bottom → top)

| z | Layer | Notes |
|---|---|---|
| 0 | Office canvas | fills the block; camera fit from `reference.md` §4 refits on every resize |
| 10 | Name tags, speech bubbles, reaction glyphs | HTML projected over the canvas (as today) |
| 20 | Moderator notice | top-centre under the top bar (today's notice, moved down 52 px) |
| 30 | Top bar | floating, pixel card |
| 30 | Collapsed chat card / peek | bottom-right on desktop, bottom sheet peek on mobile |
| 40 | Drawer / sheet | |
| 50 | Picker popover (mobile), menus | |

Pixel styling = the existing kit: `border-2 border-slate-900`, hard shadow `2px 2px 0 #0f172a`, `rounded-none`, `font-mono` for chrome, `bg-[var(--lp-card)]`. Overlays over the scene get `bg-[var(--lp-card)]/95` so the office shows through a little.

## 2. Top bar `council-topbar`

A floating card, `top: 8px; left: 8px; right: 8px` (on desktop with the drawer open: `right: drawerWidth + 8`). Height 44 px (48 px on mobile). Contents left → right:

| Item | 1280 | 768 | 375 |
|---|---|---|---|
| Title `[ Совет ]` | yes | no | no |
| Project select (`councilPick`) | select, max 14rem | select, max 10rem | inside the picker popover |
| Council select (`council-list`): option = `state · question` | select, flex 1, max 28rem | select, flex 1 | **picker button**: 1-line truncated question + ▾, opens a popover with the project select and the council list (radio rows, 2-line clamp) |
| State chip: `идёт · раунд 2/5` (`councilState_*`, `councilRound`, `round/maxRounds`); amber when live, green for `done`, red for `failed`/`stopped` | full | full | short `Р2/5` + colour dot |
| Replay ▶/⏸ ⏭ ⏹ | icon + text | icons | icons, 40 px targets; ⏹ only while the cursor is set |
| Chat toggle `council-drawer-toggle`: `💬 12` (message count; a dot when unread) | yes | yes | no, the sheet peek handles it |

No second row at any width. With the drawer docked on 1280 the bar shortens, and the council select shrinks first.

## 3. Conversation drawer `council-drawer`

### Placement per width (from `useObservedWidth`, as today)

| Block width | Mode | Size | Office |
|---|---|---|---|
| ≥ 1100 | **docked right drawer**, open by default | 380 px wide, full height under the top bar (top 60, bottom 8, right 8) | canvas keeps `inset:0`; the camera fits into the **free area** (block width − 396), so the drawer never covers the meeting room. Pixel lever: `camera.setViewOffset` or a narrower fit width |
| 641–1099 | **overlay right drawer**, closed by default | 340 px, same top/bottom | not refitted, the drawer covers the right part (director's office / entrance). Click on the canvas closes it |
| ≤ 640 | **bottom sheet** | peek 84 px → half 55 % → full (block height − 64) | canvas fills the block above the peek. Drag the sheet or tap the peek to change state |

The open/closed state is kept in `localStorage` (`lane-pilot:council:drawer`) per mode.

### Collapsed state (the latest message stays visible)

* **Desktop / tablet**: card `council-peek` at bottom-right (right 8, bottom 8), 320 px wide (768: 300 px). Contents: seat colour square, speaker name (bold mono uppercase 11 px), `· раунд N`, and the last message as 2 lines of plain text (markdown stripped). On the right: `💬 12 ›`. While someone is typing the line reads `▮ Скептик пишет…`. Click anywhere on the card to open the drawer. If a decision exists, the card shows a green `★ Решение` badge.
* **Mobile**: the sheet peek (84 px) is the same content: drag handle, a 1-line preview, `💬 12`, and a ▴ button to open half.

### Drawer contents (top → bottom)

1. **Header** (`council-header`): the question (bold mono 14 px, 3-line clamp, click expands), the state chip, a close button `✕` (sheet: handle + `▾`).
2. **Decision panel** (only when `recommendation` or `reason`): pinned under the header and **not** in the scroll. Emerald pixel card, `★ Решение`. Collapsed it shows 4 lines plus «Развернуть». Expanded it shows the full Markdown with a max height of 40 % of the drawer and its own scroll. `decisionPath` is shown in mono below. `reason` (failure) uses the red card in the same slot.
3. **Disclosures** (both collapsed, compact `Disclosure`): `Повестка (N)` (the agenda `<ol>`) and `Участники (N)` (per seat: colour square, title, `provider/model`; clicking a seat highlights the character in the office = `onSelectSpeaker`).
4. **Feed** (`council-messages`): flex 1, own scroll. Same message cards as today, but tighter: padding 8, speaker row 11 px, text 13 px. Clicking a message sets the replay cursor and highlights the speaker (as today). New messages auto-scroll only if the feed is already at the bottom; otherwise show a `↓ новые (3)` chip.
5. **Typing line** (`council-typing`), above the composer and outside the scroll.
6. **Composer** (`council-composer`): input on its own full row; below it 3 buttons in one row `Сказать` (amber, primary) · `Решать` · `Стоп` (rose). Enter sends. The composer shows only while the council is running; for a finished council it collapses into one muted line «Заседание закрыто».

The mobile sheet in **half** shows header, decision (collapsed), feed and composer. The disclosures appear only in **full**. When the input is focused the sheet goes to full, so the keyboard does not cover the feed.

## 4. Office overlays (in `council-office.tsx`)

* **Name tags**: 9 px mono, bold, uppercase, 1 line, max 10 characters (ellipsis; full name in `title`), padding 1×4, background = seat colour, 1 px outline, no 2 px border. Shown for council seats + owner + chair. Hidden by default for ambient people, shown on hover.
* **Tag collision**: after projection, sort tags by screen y. If a tag's box overlaps an earlier one by more than 30 %, collapse it to the colour dot (the `data-collapsed=true` state that already exists). The speaker and the highlighted seat never collapse.
* **Speech bubble**: only the current speaker plus the cursor message in replay. Max width 220 px desktop / 170 px mobile, 3-line clamp with the typewriter, a 6 px pixel tail pointing at the head, z above the other tags. Name line inside the bubble 9 px. Clicking the bubble opens the drawer and scrolls to that message.
* **Listener reactions** (`!`, `?`, `…`, `хм`) stay as they are.
* **Moderator notice**: top centre, 52 px below the top bar's bottom edge, max 360 px, 3 lines. On mobile, full width minus 16.
* The tags of people inside the area covered by an open overlay drawer (641–1099) are not drawn.
* **Recentre button** `⌖`: bottom-left, 36 px pixel button. On mobile it sits above the peek. It resets pan and zoom.

## 5. Sizes at the three widths (block = the plugin content area)

### 1280 × ~720
```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│┌[ Совет ] [Проект ▾] [идёт · Стоит ли делить сервер… ▾] (идёт · раунд 2/5) ▶ ⏭ 💬12 ┐┌──────────────────┐│
│└────────────────────────────────────────────────────────────────────────────────┘│ Вопрос…        ✕ ││
│                                                                                   │ ★ Решение (4 стр)││
│        O F F I C E   F L O O R  (fit into 1280 − 396 = 884 px)                    │ ▸ Повестка (5)   ││
│        bubbles over heads, small tags                                             │ ▸ Участники (6)  ││
│                                                                                   │ feed …           ││
│                                                                                   │ ▮ Скептик пишет… ││
│ ⌖                                                                                 │ [input         ] ││
│                                                                                   │ Сказать Решать Стоп│
└───────────────────────────────────────────────────────────────────────────────────┴──────────────────┘
```
With the drawer closed: the office fits the full 1280 and the peek card sits bottom-right.

### 768 × ~900
Office fits contain (the lot shows above and below). The drawer is closed by default and the peek card sits bottom-right (300 px). The open drawer is a 340 px overlay.

### 375 × ~700
```
┌──────────────────────────────┐
│[Стоит ли делить… ▾] ●Р2/5 ▶ ⏭│  48 px top bar
│                              │
│   office, cover-height,      │
│   centred on the table,      │
│   drag to pan, pinch zoom    │
│                              │
│ ⌖                            │
├──────────────────────────────┤
│ ═══  ■ СКЕПТИК · р.2   💬 12 ▴│  84 px peek
│ Я бы не делил сервер, пока… │
└──────────────────────────────┘
```

## 6. States

| State | What shows |
|---|---|
| No projects | Office with the empty floor (ambient people only). Top bar shows the project select disabled and the text `Проектов пока нет.` |
| No councils | Office with ambient people. The council select is replaced by `councilEmpty` text (1 line, full text in `title`). No drawer, no peek |
| Live council | State chip amber and pulsing. Bubbles appear, and the peek updates with every message |
| Finished | Chip green/red. Decision panel at the top of the drawer. On desktop the drawer opens once automatically when the decision arrives (not on later visits) |
| Replay | ⏹ visible. The cursor message bubble is over its speaker; the feed scrolls to the cursor; the peek shows the cursor message with a `⏵ повтор` badge |
| No WebGL | Fallback card centred over a `#acddec` background; everything else unchanged |

## 7. New strings (en / ru) for `packages/i18n`

| Key | en | ru |
|---|---|---|
| `councilChat` | Chat | Чат |
| `councilChatClose` | Hide chat | Скрыть чат |
| `councilSeats` | Participants | Участники |
| `councilRecenter` | Recenter | К столу |
| `councilNewMessages` | new ({n}) | новые ({n}) |
| `councilClosed` | Session closed | Заседание закрыто |
| `councilExpand` | Expand | Развернуть |
| `councilReplayBadge` | replay | повтор |

## 8. Acceptance checks for the writer

1. At 1280×720, 768×1024 and 375×740 the canvas element's box equals the content block (±1 px). No grey band, and the page itself does not scroll.
2. 1280 with the drawer open: the whole meeting room (grid gx 0–12, gz 0–11) is inside the free area left of the drawer.
3. 375: the peek is visible, with 1 line of the latest message; tapping it opens half; the composer buttons are ≥ 40 px tall; there is no horizontal scroll.
4. With 8 seats seated, no two full name tags overlap (screenshot check).
5. Existing council-page tests keep passing with the same test ids.
