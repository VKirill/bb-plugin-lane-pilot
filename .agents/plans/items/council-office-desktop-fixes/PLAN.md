# Council page fixes from the live browser check (thr_fmb5y7uw8k)

Production at 1280, 768 and 375 px. The office floor renders and matches the reference: all rooms, and the owner walks to the director's desk without jumps. Narrow widths correctly show the chat only. What needs fixing:

1. **The office is hidden on a normal desktop (high).** The breakpoint is measured on the content block. At a 1280 px window with the BB sidebar open, which is the default, the block is 946 px, so the owner sees the chat layout and no office. The office appears only when the sidebar is collapsed and the block is 1254 px. The owner's rule is «the office on the computer, chat only on phone and tablet».

   Fix: decide by device or window, not by block. Show the office when `window.innerWidth >= 1024` (a desktop-class window), using a matchMedia listener, even when the content block is narrower. The camera fit must handle a block down to about 700 px wide. In that case the chat drawer becomes an overlay over the office instead of a 380 px docked panel, so the office keeps at least ~620 px.

   Keep chat-only below a 1024 px window. Keep the selected council, the replay cursor and the draft when switching.
2. **Participants label (high).** The participants disclosure shows a bare "4". src/rooms/council/ui/council-page.tsx:283 uses `${detail.seats.length}` without the `councilSeats` label. Make it «Участники (4)» / «Participants (4)» on every width.
3. **Decision card (medium).** The decision card cuts its text mid-line. Clamp it to whole lines with an ellipsis and a «Развернуть» toggle, as layout.md describes.
4. **three.js in the shared bundle (medium).** three.js ships inside the single 4.3 MB dist/app.js, so phones download it too. Check whether `bb plugin build` supports code splitting for dynamic `import("three")`. If it does, make three.js a separate chunk loaded only on desktop. If it does not, say so in the final answer and leave the bundle as is.

## Checks
In tests/council-page.test.tsx:
- with a mocked window width of 1280 and a container width of 946, the office is shown and the chat drawer is an overlay;
- with a window width of 800, chat only;
- the participants summary reads «Участники (4)».

Also typecheck and build.

## Delivery
- [x] Showed the office on desktop windows with the sidebar open, fixed participant and decision labels, and split the desktop scene where supported — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`; merged as `b04482a`.
