import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import type { OwnerMessage } from "../../src/rooms/anamnesis/owner-messages";
import { DEFAULT_CONFIG, type LearningConfig } from "../../src/rooms/learning/config";

export const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
export const database = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);

let counter = 0;
export const message = (text: string, over: Partial<OwnerMessage> = {}): OwnerMessage =>
  ({ id: `thr_a:${++counter}:0`, threadId: "thr_a", projectId: "proj_1", at: NOW - 60_000, text, ...over });

export const config = (over: Partial<LearningConfig> = {}): LearningConfig => ({ ...DEFAULT_CONFIG, ...over });
