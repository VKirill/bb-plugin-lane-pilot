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

// Tests script the host call by call; the one that checks the job path switches it on (packages/host-calls/tests/host-jobs.test.ts).
process.env.LANE_PILOT_HOST_JOBS ??= "0";
// Fake threads change state without BB's events, so tests watch them by polling; tests/thread-signals.test.ts switches the events on.
process.env.LANE_PILOT_THREAD_SIGNALS ??= "0";
