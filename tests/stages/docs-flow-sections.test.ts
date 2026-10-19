import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nightlyDocsPrompt } from "../../src/rooms/docs/docs";
import { lintDocsPages } from "../../src/rooms/docs/docs-lint";

// treba, 2026-10-19 (thr_w5rqy2puij): in its only repair round the root docs agent moved the attribution steps to a new
// docs/flows/tracking-attribution.md, as the repair prompt asks when a page is near the size limit, with exactly the
// sections the brief listed for a flow page. The lint also requires '## Capabilities' on a flow page, which the root
// brief never named, so that one finding failed the pass and nothing was committed.
const fixture = readFileSync(join(__dirname, "../fixtures/docs/treba-tracking-attribution-flow.md"), "utf8");
const structure = (path:string, content:string) => lintDocsPages([{ path, content }], {}).filter((finding) => finding.rule === "structure").map((finding) => finding.detail);

it("the real flow page fails only on the section the brief did not name", () => {
  expect(structure("docs/flows/tracking-attribution.md", fixture)).toEqual([expect.stringMatching(/^a flow page needs a '## Capabilities' section/)]);
});

it("a flow or component page with the sections the brief lists passes the structure checks, in every docs pass", () => {
  const briefs = [
    nightlyDocsPrompt({ since:"yesterday", hasDocs:true, changed:["server/utils/attribution.ts"] }),
    nightlyDocsPrompt({ since:"yesterday", hasDocs:false, changed:[] }),
    nightlyDocsPrompt({ since:"yesterday", hasDocs:true, changed:[], unit:{ docsDir:"apps/api/docs", workspace:{ path:"apps/api", name:"api" } } }),
  ];
  const citations = Array.from({ length:15 }, (_, index) => `\`server/utils/attribution.ts:${index + 1}\``).join(", ");
  const page = (type:string, sections:string[]) => ["---", "title: Attribution", `type: ${type}`, "created: 2026-10-19", "updated: 2026-10-19",
    "status: active", "confidence: medium", "tags:", "- attribution", "sources:", "- server/utils/attribution.ts", "---",
    "# Attribution", "", "TL;DR: one line.", "", ...sections.flatMap((section) => [`## ${section}`, "", `Text (${citations}).`, ""])].join("\n");
  for (const brief of briefs) {
    const flow = brief.match(/A flow page \(docs\/flows\/\) has: ([^.]+)\./)?.[1];
    const component = brief.match(/A component page has: (.+?)\. A flow page/)?.[1];
    expect(flow).toBeTruthy();
    expect(component).toBeTruthy();
    const names = (list:string) => list.split(";").map((part) => part.split(" - ")[0]!.trim()).filter(Boolean);
    expect(structure("docs/flows/attribution.md", page("flow", names(flow!)))).toEqual([]);
    expect(structure("docs/components/attribution.md", page("component", names(component!)))).toEqual([]);
  }
});
