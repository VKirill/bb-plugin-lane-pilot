import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { workflowCategory } from "../../src/rooms/workflow/categories";

it("puts every built-in graph on a shelf by its id and tags", () => {
  const of = (id: string) => workflowCategory(JSON.parse(readFileSync(`workflows/${readdirSync("workflows").find((f) => f === `${id}.json`)}`, "utf8")));
  expect([of("seo-page"), of("lp.plan"), of("lead-tick"), of("invoice-send"), of("ins.post"), of("social-post"), of("roblox-asset"), of("macos-routine"), of("quality-loop"), of("issue-quick")])
    .toEqual(["seo", "service", "service", "business", "research", "content", "games", "routines", "code", "code"]);
  expect(workflowCategory({ id: "client-thing" })).toBe("code");
});
