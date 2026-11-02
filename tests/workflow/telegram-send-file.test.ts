import { describe, expect, it } from "vitest";
import { sendFileCommand, sendFileOutput } from "../../src/rooms/workflow/server/workflow-telegram";

describe("telegram.send_file", () => {
  it("quotes every argument for the shell", () => {
    expect(sendFileCommand({ chat: "@ivan", file_path: "/x/it's.pdf", caption: "Счёт № 1" }))
      .toBe(`"$HOME/toolkit/telegram/tg" send-file '@ivan' '/x/it'\\''s.pdf' --caption 'Счёт № 1' --execute`);
  });
  it("reads tg's last JSON line: sent, already there, unverified, error", () => {
    expect(sendFileOutput(0, 'noise\n{"status":"sent","message_id":7,"message_url":"u"}')).toMatchObject({ status: "sent", message_id: "7", reason: "" });
    expect(sendFileOutput(0, '{"status":"already_there","message_id":5,"date":"2026-11-02"}')).toMatchObject({ status: "sent", message_id: "5", reason: expect.stringContaining("not sent again") });
    expect(sendFileOutput(0, '{"status":"sent_unverified","message_id":8}').status).toBe("unsure");
    expect(sendFileOutput(1, '{"error":"UserError","detail":"No such file"}')).toMatchObject({ status: "failed", reason: "tg: UserError No such file" });
    expect(sendFileOutput(0, "not json").status).toBe("failed");
  });
});
