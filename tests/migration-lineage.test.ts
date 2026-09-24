import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { migrations, openDatabase } from "../src/database";

const installed011MigrationHashes = [
  "ee647cc1d58d276e464d6d6a6fb2ce5926998c0d6f28bdb8bae9608fdb65bc02",
  "2c3d9bb116b7b3f1a02e46c08e1c1c70727385e0b3ca378b08467856abf8188a",
  "8273f68631753b45a7e9b2491a2ce3a01b36eae7600881227d655261ff257c9f",
  "51053669bf3f48130be209dee134f2f0747b1d9af5c4a54d5d6857712a1886e7",
  "b453807ac70ef83bf423575d5d93bba3430ff5e7c71c764332fa4f033838b5d5",
  "2c979d960284d49156af4771b05be082a322540ef711860b08b6cbd667e4f510",
  "e55875f3d4b9a647d0a950bac11c199e3f63d891c9f33a96df6cb76ed429af51",
  "ed205edf71eb77329ccd0a64c91e266236ad6268b15e0feb57edfb687707187e",
  "cfc20e54aa754763fc78334dec64d42e505eaa23cbd2acfcdb320f51c44ea238",
  "f43ffb2b1a6b0867150cbe46ec4794ec16bc151a3b5c1d3af87f2c47ea9740be",
  "f07e4477d504ddb73494ab0196d4a893e593e6614832d2fca74cfff891a85fb2",
  "a713f922a5c01ff684f4444c11e8b4f3cd621bfc8a95fdc384e8e9744ff34610",
  "50a028b5dc091da74d81eae12a3fb24120737df052d6a7337df04634d861c586",
  "5ccc08f9a7c95357406e801e6f5b95c1e2eecf9f8f36ee9f494dbe190cebdac8",
  "38b98ce65547ae57852b35c0f45fd7b74653b39be77fa819a682c6d082c2ef5f",
  "630f1271ebbd4496683feea65b4925f7a64c722ccca2f4090b91dfa635a70ebd",
  "b9c253d10c245b6b788b40ab66c06b6585a671a69cdc9617576a91bd75a2af65",
  "c9bfeb3b420f1c1c4218938b7e57186222a1827a63359e44b6cd689d4cadfe73",
  "8392fb63f6c76f685f9064aaf0b49304c08a31e7e6126b21a42ae8f536b4657d",
  "f67351b6fb4b46d721d6955d8f9a886fb06dfad80b688922605fec66944caf31",
  "4e252e7a2948bdd7903ee14ee13b9dfb6e74b94213c1537cfd96436d65bdedf6",
  "70416f771dd285702b5cf2fe1cb92607b5e5f55c98532740c9553b1edaae15ad",
  "c7be7ec04ff0029f8268581bd43cc481c6ae52a743b0d08760959ba2876f4447",
  "7b57e7a86bb5b2ec749205abb11cb2dc63902b34f4aad09b1db70a766c9eeb4b",
];

describe("installed 0.1.11 migration lineage", () => {
  it("keeps all applied statements byte-identical and upgrades populated storage", async () => {
    const currentHashes = migrations.slice(0, installed011MigrationHashes.length)
      .map((statement) => createHash("sha256").update(statement).digest("hex"));
    expect(currentHashes).toEqual(installed011MigrationHashes);

    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations.slice(0, installed011MigrationHashes.length));
    db.prepare(`INSERT INTO lane_pilot_project_settings
      (project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,?,?)`)
      .run("project-existing", "", "writer.provider", '"codex"', 3, 1710000000000);
    db.prepare(`INSERT INTO lane_pilot_run
      (id,project_id,state,created_at,updated_at,kind,closed_at) VALUES (?,?,?,?,?,?,?)`)
      .run("run-existing", "project-existing", "accepted", 1710000000000, 1710000000100, "bb", null);
    db.prepare(`INSERT INTO lane_pilot_task
      (id,run_id,kind,contract_json,created_at) VALUES (?,?,?,?,?)`)
      .run("task-existing", "run-existing", "bb", '{"title":"preserve"}', 1710000000000);
    db.prepare(`INSERT INTO lane_pilot_attempt
      (id,run_id,task_id,state,reason,created_at,updated_at,attempt_no,dirt_before_json)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run("attempt-existing", "run-existing", "task-existing", "accepted", null, 1710000000000, 1710000000100, 2, "[]");

    openDatabase(bb);

    expect(db.prepare(`SELECT value,version FROM lane_pilot_project_settings
      WHERE project_id='project-existing' AND key='writer.provider'`).get())
      .toEqual({ value: '"codex"', version: 3 });
    expect(db.prepare("SELECT id,state FROM lane_pilot_run WHERE id='run-existing'").get())
      .toEqual({ id: "run-existing", state: "accepted" });
    expect(db.prepare("SELECT id,attempt_no FROM lane_pilot_attempt WHERE id='attempt-existing'").get())
      .toEqual({ id: "attempt-existing", attempt_no: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get())
      .toEqual({ count: migrations.length });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    await harness.lifecycle.dispose();
  });
});
