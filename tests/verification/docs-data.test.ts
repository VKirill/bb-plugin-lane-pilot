import { expect, it } from "vitest";
import { parsePrisma, prismaAccess, renderDataMap } from "../../src/rooms/verification/docs-data";

const schema = ["enum Role {", "  USER", "  ADMIN // staff", "}", "", "model Generation {", "  id     String @id", "  status String @default(\"pending\") // pipeline state",
  "  user   User   @relation(fields: [userId], references: [id])", "  role   Role", "  @@map(\"generations\")", "}", "model User {", "  id String @id", "}"].join("\n");

it("reads models, fields, enums and table names from a Prisma schema", () => {
  const { models, enums } = parsePrisma("prisma/schema.prisma", schema);
  expect(enums).toEqual([{ name:"Role", values:["USER", "ADMIN"], file:"prisma/schema.prisma", line:1 }]);
  expect(models[0]).toMatchObject({ name:"Generation", table:"generations", line:6, endLine:12 });
  expect(models[0]!.fields.map((field) => `${field.name}:${field.type}:${field.note}`)).toEqual(["id:String:", "status:String:pipeline state", "user:User:", "role:Role:"]);
});

it("finds writes with the status values they set, and reads, across the repository", () => {
  const { models, enums } = parsePrisma("prisma/schema.prisma", schema);
  const access = prismaAccess(new Map([
    ["src/start.ts", "await tx.generation.create({ data: { status: 'pending' } });\nconst g = await this.prisma.generation.findUnique({ where });"],
    ["src/done.ts", "await prisma.generation.update({ where, data: { status: \"completed\" } });"],
    ["src/lease.ts", "await tx.$executeRaw`UPDATE generations SET status = 'generating', lease_token = ${t} WHERE id = ${id}`;"],
  ]), models.map((model) => model.name), new Map([["generations", "Generation"]]));
  expect(access.get("Generation")).toEqual({
    writes:[{ file:"src/start.ts", line:1, op:"create", values:["status=pending"] }, { file:"src/done.ts", line:1, op:"update", values:["status=completed"] },
      { file:"src/lease.ts", line:1, op:"SQL UPDATE", values:["status=generating"] }],
    reads:[{ file:"src/start.ts", line:2, op:"findUnique" }],
  });
  const map = renderDataMap(models, enums, access).join("\n");
  expect(map).toContain("### Generation -> generations (prisma/schema.prisma:6-12)");
  expect(map).toContain("- status String (line 8) - values written: pending, completed, generating; // pipeline state");
  expect(map).toContain("- user User (line 9) - -> User");
  expect(map).toContain("- role Role (line 10) - enum Role: USER, ADMIN");
  expect(map).toContain("- writes (3): src/start.ts:1 create, src/done.ts:1 update, src/lease.ts:1 SQL UPDATE");
});
