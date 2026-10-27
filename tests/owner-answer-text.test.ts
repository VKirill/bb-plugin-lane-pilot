import { describe, expect, it } from "vitest";
import { ownerAnswerText } from "../src/rooms/tools/owner-answer-text";

// The owner saw `{ "answered": true, "choice": null, "text": "…" }` in the chat (2026-10-27): the delivered result is now readable markdown.
describe("lane_pilot_ask_owner's result text", () => {
  it("reads as the owner's answer, not JSON", () => {
    const text = ownerAnswerText({ answered: true, choice: null, text: "Основные языки европы, оплата звездами и страйп, 1 бесплатная генерация" }, "ru");
    expect(text).toBe("**Владелец ответил**\n\n**Ответ:**\n\n> Основные языки европы, оплата звездами и страйп, 1 бесплатная генерация");
    expect(text).not.toMatch(/[{}]|"answered"/);
  });
  it("shows a tapped choice, a multi-line reply as a quote, and the English form", () => {
    expect(ownerAnswerText({ answered: true, choice: "Да", text: null }, "ru")).toBe("**Владелец ответил**\n\n**Выбор:** Да");
    expect(ownerAnswerText({ answered: true, choice: "Yes", text: "line one\nline two" }, "en")).toBe("**The owner answered**\n\n**Choice:** Yes\n\n**Reply:**\n\n> line one\n> line two");
  });
  it("says what to do when the owner did not answer", () => {
    expect(ownerAnswerText({ answered: false, reason: "timeout" }, "ru")).toContain("Владелец не ответил вовремя");
    expect(ownerAnswerText({ answered: false, reason: "dismissed" }, "en")).toContain("The owner dismissed the question");
  });
});
