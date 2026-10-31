import { describe, expect, it } from "vitest";
import { CREDENTIAL_MASK, withoutCredentials } from "@lane-pilot/kit";

// magicseo replay 2026-10-31: the ТЗ «Авторизация у меня там такая <email> <password>» went verbatim into the phase goal, so the password
// stood in BOOK.md, CONTEXT.md and SECURITY.md of the repository, in the first commit and in every helper's prompt.
describe("a phase goal carries no credential", () => {
  it("hides the word after an email and a value after a keyword; keeps the email, links and plain words", () => {
    const tz = "https://lk.example.ru/ - надо просканировать сервис. Авторизация у меня там такая owner.name@mail.ru Xk7#pq92z\n\nМоя цель — проекты.";
    const out = withoutCredentials(tz);
    expect(out).not.toContain("Xk7#pq92z");
    expect(out).toContain(`owner.name@mail.ru ${CREDENTIAL_MASK}`);
    expect(out).toContain("https://lk.example.ru/");
    expect(withoutCredentials("логин admin, пароль: hunter22, токен abcd1234ef")).not.toMatch(/hunter22|abcd1234ef/);
    expect(withoutCredentials("password=Secr3t! then go")).toBe(`password=${CREDENTIAL_MASK} then go`);
    expect(withoutCredentials(out)).toBe(out);
    // Plain prose stays: no Latin letter or digit after the keyword, an email followed by words, a link after an email.
    expect(withoutCredentials("пароль такой же, как раньше")).toBe("пароль такой же, как раньше");
    expect(withoutCredentials("пиши на team@site.ru когда будет готово")).toBe("пиши на team@site.ru когда будет готово");
    expect(withoutCredentials("team@site.ru https://site.ru/login")).toBe("team@site.ru https://site.ru/login");
  });

  it("is applied where a phase is stored and read", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../src/rooms/storage");
    const { insertPhase, getPhase } = await import("../src/rooms/phase/store");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    insertPhase(db as never, { id: "ph_1", projectId: "P", pmThreadId: "pm", title: "Сервис", goal: "вход: me@x.ru Pa55word!", at: 1 });
    expect(getPhase(db as never, "ph_1")!.goal).toBe(`вход: me@x.ru ${CREDENTIAL_MASK}`);
    // A phase stored before the fix (raw in the row) reads cleaned too.
    db.prepare("UPDATE lane_pilot_phase SET goal=? WHERE id=?").run("вход: me@x.ru Pa55word!", "ph_1");
    expect(getPhase(db as never, "ph_1")!.goal).not.toContain("Pa55word!");
  });
});
