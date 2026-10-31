import { expect, it } from "vitest";
import { createRelay, type RelayItem } from "../src/rooms/relay/server/relay";

// Hub 2026-10-31: a helper settled while the PM that asked it was archived. The answer's send got 409 «Thread is archived», threw out
// of the whole update, the wait stayed open and was tried again on every thread event; a self-repair was opened for the warnings.
it("closes a wait whose thread is archived instead of failing the event over and over", async () => {
  let items:RelayItem[] = [];
  const tries:string[] = [];
  const relay = createRelay({
    load:async () => structuredClone(items),
    save:async (next) => { items = structuredClone(next); },
    send:async (threadId) => { tries.push(threadId); if (threadId === "pm") throw new Error("HTTP 409: Thread is archived"); },
    settled:async () => true,
    output:async () => "done",
    busy:async () => false,
    taskStates:async () => ({}),
    now:() => 10_000_000,
    log:() => undefined,
  });
  await relay.ask({ projectId:"P", fromThreadId:"pm", toThreadId:"helper", question:"what changed?" });
  await relay.remind({ projectId:"P", threadId:"pm", note:"check the helper", inMinutes:30, watchThreadId:"helper" });
  tries.length = 0;
  // The answer closes the reminder that watched the same thread (closeAnsweredWaits): one send, to the archived PM.
  expect(await relay.threadSettled("helper")).toBe(1);
  expect(tries).toEqual(["pm"]);
  expect(await relay.threadSettled("helper")).toBe(0);
  expect(tries).toEqual(["pm"]);
});
