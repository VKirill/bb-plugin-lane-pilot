import { z } from "zod";

/** The docs pipeline on the host: project scans the nightly and onboarding passes read, and their Jev-backed builders. */
export const docsHostMethods = {
  gitDocsScope: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), sinceEpochMs:z.number().int().nonnegative(), base:z.string().min(1).max(200).optional(),
      docsDir:z.string().min(1).max(240).regex(/^(?!\/)(?!.*\.\.)[^\0]+$/).optional(), exclude:z.array(z.string().min(1).max(240)).max(50).optional() }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), isRepoRoot:z.boolean(), hasDocs:z.boolean(), changed:z.array(z.string()), dirty:z.array(z.string()), base:z.string().nullable(),
      workspaces:z.array(z.object({ path:z.string(), name:z.string(), codeFiles:z.number().int() })), localDate:z.string(), localHour:z.number().int(), reason:z.string().nullable() }).strict(),
  },
  docsWorthinessFacts: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/") }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["ready","not-git","failed"]), trackedFiles:z.number().int(), codeFiles:z.number().int(), testFiles:z.number().int(),
      contentFiles:z.number().int(), languages:z.array(z.object({ ext:z.string(), files:z.number().int() })), commits30d:z.number().int(), manifests:z.array(z.string()),
      deploy:z.boolean(), docsPages:z.number().int(), reason:z.string().nullable() }).strict(),
  },
  docsAnchors: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), title:z.string() })).max(500),
      prefix:z.string().max(240).optional(), exclude:z.array(z.string()).max(500).optional(),
      workspaces:z.array(z.object({ path:z.string(), name:z.string(), docsDir:z.string().nullable() })).max(500).optional() }).strict(),
    output: z.object({ hostId:z.string(), briefPath:z.string(), anchors:z.number().int(), jev:z.enum(["ok","partial","disabled"]), productFiles:z.array(z.string()),
      core:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })), tables:z.array(z.string()), deploy:z.boolean() }).strict(),
  },
  docsFlows: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), workspaces:z.array(z.object({ path:z.string(), name:z.string() })).max(500),
      keep:z.array(z.string()).max(200).optional() }).strict(),
    output: z.object({ hostId:z.string(), briefPath:z.string(), jev:z.enum(["ok","partial","disabled"]), routes:z.number().int(),
      flows:z.array(z.object({ name:z.string(), slug:z.string(), entries:z.number().int(), modules:z.array(z.string()), briefPath:z.string(), files:z.array(z.string()),
        calls:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })) })) }).strict(),
  },
  docsDepth: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500),
      core:z.array(z.object({ name:z.string(), file:z.string(), line:z.number().int(), endLine:z.number().int() })).max(2000) }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), findings:z.array(z.object({ path:z.string(), rule:z.string(), detail:z.string() })) }).strict(),
  },
  docsVerifyCitations: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500),
      related:z.array(z.object({ path:z.string(), content:z.string() })).max(500).optional() }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), checked:z.number().int(), findings:z.array(z.object({ path:z.string(), rule:z.string(), detail:z.string() })),
      pageStats:z.array(z.object({ path:z.string(), checked:z.number().int(), supported:z.number().int(), partial:z.number().int() })) }).strict(),
  },
  docsStaleness: {
    input: z.object({ requestedHostId:z.string().min(1), jevApiKey:z.string().max(4096).optional(), jevProvider:z.enum(["openlux","typesafe"]).optional(), projectCwd:z.string().startsWith("/"), base:z.string().min(1), changed:z.array(z.string()).max(5000), pages:z.array(z.object({ path:z.string(), content:z.string() })).max(500) }).strict(),
    output: z.object({ hostId:z.string(), jev:z.enum(["ok","partial","disabled"]), refresh:z.array(z.string()), reasons:z.array(z.object({ path:z.string(), section:z.string(), p:z.number() })) }).strict(),
  },
  docsLineCounts: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), files:z.array(z.string()).max(2000) }).strict(),
    output: z.object({ hostId:z.string(), counts:z.record(z.string(), z.number().int().nullable()) }).strict(),
  },
  gitCommitDocs: {
    input: z.object({ requestedHostId:z.string().min(1), projectCwd:z.string().startsWith("/"), paths:z.array(z.string()).max(2000), message:z.string().min(1).max(500) }).strict(),
    output: z.object({ hostId:z.string(), status:z.enum(["committed","nothing","failed"]), commit:z.string().nullable(), reason:z.string().nullable() }).strict(),
  },
};
