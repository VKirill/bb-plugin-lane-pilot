class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
}

if (typeof window !== "undefined") {
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
  window.HTMLElement.prototype.setPointerCapture ??= () => {};
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false; },
    });
  }
}

// i18n's detectLocale() looks for the Russianizer footer marker on every t() call: one full-document scan each, which was
// most of the CPU of the page tests (7.8 of 12 s in "renders every setting row", a page of several thousand nodes). The answer
// is kept until the DOM reports a change; takeRecords() hands over pending mutations synchronously, so a marker added just
// before the call is still seen at once.
if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  const footerMarker = '[data-footer-item="plugin:ru/toggle"]';
  const nativeQuery = Document.prototype.querySelector;
  let cached: Element | null | undefined;
  const observer = new MutationObserver(() => { cached = undefined; });
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-footer-item"] });
  Document.prototype.querySelector = function (this: Document, selectors: string) {
    if (this !== document || selectors !== footerMarker) return nativeQuery.call(this, selectors);
    if (observer.takeRecords().length) cached = undefined;
    if (cached === undefined) cached = nativeQuery.call(this, selectors);
    return cached;
  } as Document["querySelector"];
}

// Tests script the host call by call; the one that checks the job path switches it on (packages/host-calls/tests/host-jobs.test.ts).
process.env.LANE_PILOT_HOST_JOBS ??= "0";
// Fake threads change state without BB's events, so tests watch them by polling; tests/thread-signals.test.ts switches the events on.
process.env.LANE_PILOT_THREAD_SIGNALS ??= "0";
// Poll and retry pauses of the code under test (packages/kit/src/pace.ts) run at a twentieth of their production length.
process.env.LANE_PILOT_POLL_SCALE = "0.05"; // set, not ??=: a test file may change it and the worker is reused
