import { expect, it } from "vitest";
import {
  SETTING_EPISODES_PROCESS_KEY,
  SETTING_EVENTS_WEBHOOK_URL,
  SETTING_INSTALL_LAST_RECEIPT,
  SETTING_JEV_PROVIDER,
  SETTING_WORKER_STRICT_USER,
  SETTING_WORKER_USER,
  SETTING_WRITER_CAPACITY_WAIT_MAX_MIN,
  SETTING_WRITER_SILENCE_NUDGE_MIN,
  SETTING_CATALOG,
} from "@lane-pilot/settings-catalog";

// Pin the persisted row keys: a rename breaks every stored setting, so these strings are frozen.
it("keeps the shared setting keys byte-identical", () => {
  expect(SETTING_WRITER_SILENCE_NUDGE_MIN).toBe("writer.silence_nudge_min");
  expect(SETTING_WRITER_CAPACITY_WAIT_MAX_MIN).toBe("writer.capacity_wait_max_min");
  expect(SETTING_EVENTS_WEBHOOK_URL).toBe("events.webhook_url");
  expect(SETTING_JEV_PROVIDER).toBe("jev.provider");
  expect(SETTING_WORKER_STRICT_USER).toBe("worker.strict_user");
  expect(SETTING_WORKER_USER).toBe("worker.user");
  expect(SETTING_INSTALL_LAST_RECEIPT).toBe("install.lastReceipt");
  expect(SETTING_EPISODES_PROCESS_KEY).toBe("episodes.process_key");
});

it("keeps the catalog rows on the same key objects", () => {
  const keys = new Set(SETTING_CATALOG.map((row) => row.key));
  for (const key of [SETTING_JEV_PROVIDER, SETTING_WRITER_SILENCE_NUDGE_MIN, SETTING_WRITER_CAPACITY_WAIT_MAX_MIN, SETTING_EPISODES_PROCESS_KEY]) {
    expect(keys.has(key), key).toBe(true);
  }
});
