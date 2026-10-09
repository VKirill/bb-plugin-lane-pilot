# Realtime council test after the desktop office switch

The deploy gate fails on tests/realtime-ui.test.tsx «the council page follows the server's signals (H6) > shows a new message at once on a council signal for its project» with `Unable to find an element by: [data-testid="council-messages"]`.

Cause: council-office-desktop-fixes made the window width decide the layout. jsdom's default `window.innerWidth` is 1024, so the page renders the desktop office with the chat drawer collapsed (`data-council-layout="desktop"`, `data-drawer-mode="overlay"`), and the feed is not in the DOM.

The test is about realtime signals, not layout, so:
- Fix the test setup only. In that council test, set `window.innerWidth` to a narrow width such as 800 and dispatch `resize`, the same way tests/council-page.test.tsx does. That renders the chat-only page, where `council-messages` is visible.
- Restore the width after the test.
- Do not change product code, and do not change other tests in the file.
- Run the whole file together with tests/council-page.test.tsx.

## Delivery
- [x] Realtime council coverage now renders the chat layout at a narrow test width — accepted in run `lprun_3830fb02731046e89c6d9706ca217fd7`.
