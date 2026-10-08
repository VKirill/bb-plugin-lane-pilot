import { describe, expect, it } from "vitest";
import { en, ru } from "@lane-pilot/i18n";
import { anamnesisEn } from "../src/i18n-anamnesis";
import { fieldEn } from "../src/i18n-fields";
import { canvasEn } from "../src/i18n-workflow-canvas";
import { editorEn } from "../src/i18n-workflow-editor";
import { modelsEn } from "../src/i18n-workflow-models";
import { opsEn } from "../src/i18n-workflow-ops";
import { workflowEn } from "../src/i18n-workflows";
import { ownedEn } from "../src/i18n-owned";
import { scheduleEn } from "../src/i18n-schedule";
import { tabsEn } from "../src/i18n-tabs";

/**
 * The dictionaries are spread into one object, so a key defined in two partial dictionaries is shadowed by the later
 * one and the first text is dead. (`wfRunLive` was defined in i18n-workflows.ts and i18n-workflow-ops.ts.)
 */
describe("i18n dictionaries", () => {
  it("defines every key of the partial dictionaries once", () => {
    const partials = { fieldEn, workflowEn, editorEn, opsEn, modelsEn, canvasEn, scheduleEn, anamnesisEn, tabsEn, ownedEn };
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [name, dictionary] of Object.entries(partials)) {
      for (const key of Object.keys(dictionary)) {
        const first = owner.get(key);
        if (first) duplicates.push(`${key}: ${first} and ${name}`);
        else owner.set(key, name);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it("has the same keys in English and Russian", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });
});
