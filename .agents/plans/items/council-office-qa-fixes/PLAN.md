# Council page: fix wide layout and office overlay defects from browser QA

Live browser QA on 2026-10-09 (thread thr_tz6f5q3pfq; bb.vechkasov.pro, SelfyStudio finished councils, 375/768/1280 px × 900 px high) found these defects in the page accepted as council-office-live. This task runs after council-office-characters (it rewrites the office scene); apply the overlay fixes on top of that version.

## High: wide layout hides the office, log and composer (1280 px)
`src/rooms/council/ui/council-page.tsx` around line 257: in the wide (non-compact) layout the header (`data-testid=council-header`) is `shrink-0` with no height limit and shows the full question plus the agenda. It sits inside an `overflow-hidden` section.
- On the default council ("Follow-up to council…") the header is 749 px tall. The office, log and composer get 0 px and are clipped.
- On the shorter council the header is 447 px. The log is a 24 px strip (scrollHeight 4261), and the composer buttons (y 848–880) are cut by the section bottom at 871.

Fix: the header is always bounded in the wide layout as well. Show the question clamped to 2–3 lines, with the full question and the agenda behind the same `Disclosure` the compact layout already uses (there the header is 83–91 px). If it is expanded, give it a max height of about 30% with its own scroll. The office gets a fixed share (about 45–55%, min 240 px) and the log the rest (min 160 px). The composer is always fully visible. Check that the composer, the office and at least 160 px of log stay visible at 1280×900 and 768×900 for the long "Follow-up…" council.

## Medium/low: office overlay (src/rooms/council/ui/council-office.tsx)
- The speech bubble is clipped at the top of the office when the speaker stands near the back wall, which hides the speaker line. Keep bubbles inside the office bounds: clamp the projected position and flip the bubble below the head when there is no room above.
- Bubbles show raw markdown (`**`, `###`, backticks). Strip markdown to plain text before cutting the bubble prefix (a pure helper in office-behaviour.ts, tested).
- Name labels overlap (Product director under Skeptic) and are cut at the office edges at 375 px. Clamp labels inside the office bounds. When labels collide, offset them vertically or show only the speaker's and the highlighted label in full, with small dots for the others.
- Product director and Skeptic got the same color rgb(16,185,129) from seatColor. Assign colors so the seats of one council never share a color: pick by seat index within the council from a palette of at least 8 distinct colors, with the hash only as the fallback. Log avatars and characters must match.
- Moderator messages have no character, so clicking one shows nothing. Show moderator messages as a small notice board or wall-speaker bubble in the office (no character), and highlight it when such a message is selected or replayed.

## Low: 375 px header
After a message is selected, the «■ Сброс» button appears in the top bar and squeezes the project select to about 41 px («S»). Move the reset control next to the replay controls (or let it wrap) so the project select keeps a usable width.

## Checks
- tests/council-office.test.ts: markdown stripping for bubbles; distinct colors for up to 8 seats in one council.
- tests/council-page.test.tsx: in the wide layout the header renders the clamped question with the agenda behind a disclosure. Existing assertions keep passing.

## Delivery
- [x] Bounded the council layout and fixed bubble/label clipping, seat colors, moderator presence, and narrow reset controls — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `d58fc68`.
