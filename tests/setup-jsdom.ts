import { vi } from "vitest";

// A worker that keeps its module cache between files (isolate: false) starts every file with an empty module registry: plugin
// modules keep state at module level (a bound drain, a provided key, hooks registered by a shared helper) and files must not see
// each other's. Packages from node_modules stay loaded, which is most of what isolation re-imported.
vi.resetModules();

// A worker that keeps its module cache between files (isolate: false) also keeps process.env: every file starts from the
// environment the worker began with, so a knob one test switched on (or a key it stubbed) does not reach the next file.
const startEnv = ((globalThis as { lpStartEnv?: Record<string, string | undefined> }).lpStartEnv ??= { ...process.env });
for (const key of Object.keys(process.env)) if (!(key in startEnv)) delete process.env[key];
for (const [key, value] of Object.entries(startEnv)) if (process.env[key] !== value) process.env[key] = value;
const startCwd = ((globalThis as { lpStartCwd?: string }).lpStartCwd ??= process.cwd());
if (process.cwd() !== startCwd) process.chdir(startCwd);

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
// A worker that does not isolate files runs this setup again on the same document: patch once.
if (typeof document !== "undefined" && typeof MutationObserver !== "undefined" && !(Document.prototype.querySelector as { lpMarkerCache?: true }).lpMarkerCache) {
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
  (Document.prototype.querySelector as { lpMarkerCache?: true }).lpMarkerCache = true;
}

// Tests script the host call by call; the one that checks the job path switches it on (packages/host-calls/tests/host-jobs.test.ts).
process.env.LANE_PILOT_HOST_JOBS ??= "0";
// Fake threads change state without BB's events, so tests watch them by polling; tests/thread-signals.test.ts switches the events on.
process.env.LANE_PILOT_THREAD_SIGNALS ??= "0";
// Poll and retry pauses of the code under test (packages/kit/src/pace.ts) run at a twentieth of their production length.
process.env.LANE_PILOT_POLL_SCALE = "0.05"; // set, not ??=: a test file may change it and the worker is reused
