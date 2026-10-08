import { describe, expect, it } from "vitest";
import { maskPii } from "../../src/rooms/anamnesis/pii";

// Audit 2026-10-08 round 4, item 19 (F-5): the filter before Jev was word-only, so e-mails, phones, card and account numbers,
// documents and addresses went to a third party unchanged.
const masked = (text: string) => maskPii(text).text;

describe("what must not leave the machine in a message", () => {
  it("masks e-mail addresses", () => {
    expect(masked("напиши на ivan.petrov+work@mail.example.ru до пятницы")).toBe("напиши на [email] до пятницы");
    expect(masked("write to Анна@почта.рф please")).toBe("write to [email] please");
  });

  it("masks phone numbers in the usual spellings", () => {
    for (const phone of ["+7 (916) 123-45-67", "8 916 123 45 67", "89161234567", "+34 612 345 678", "+1 415-555-0132", "+7(916)1234567"]) {
      expect(masked(`звони ${phone} после обеда`), phone).toBe("звони [phone] после обеда");
    }
  });

  it("masks a bare ten-digit mobile number as a phone, or as an INN when its check digits happen to hold", () => {
    expect(masked("звони 9161234567 после обеда")).toMatch(/звони \[(phone|inn)\] после обеда/);
  });

  it("masks card numbers that pass the Luhn check, with spaces or dashes, and leaves other long numbers alone", () => {
    expect(masked("карта 4111 1111 1111 1111 срок 12/29")).toBe("карта [card] срок 12/29");
    expect(masked("card 5555-5555-5555-4444.")).toBe("card [card].");
    expect(masked("order 1234567890123456 shipped")).toContain("1234567890123456");
  });

  it("masks IBANs and 20-digit Russian accounts", () => {
    expect(masked("IBAN DE89 3704 0044 0532 0130 00 для оплаты")).toBe("IBAN [iban] для оплаты");
    expect(masked("р/с 40702810200000012345 в банке")).toBe("р/с [account] в банке");
  });

  it("masks INN, SNILS and passport numbers", () => {
    expect(masked("ИНН 7707083893 у клиента")).toBe("ИНН [inn] у клиента");
    expect(masked("инн: 500100732259")).toBe("инн: [inn]");
    expect(masked("реквизиты 7707083893 в письме")).toBe("реквизиты [inn] в письме");
    expect(masked("СНИЛС 112-233-445 95")).toBe("СНИЛС [snils]");
    expect(masked("снилс 11223344595")).toBe("снилс [snils]");
    expect(masked("паспорт 45 08 123456 выдан")).toBe("паспорт [passport] выдан");
    expect(masked("passport 4508 123456")).toBe("passport [passport]");
  });

  it("masks addresses written the Russian and the English way", () => {
    expect(masked("живу на ул. Ленина, д. 5, кв. 12 с лета")).toBe("живу на [address] с лета");
    expect(masked("офис: проспект Мира 101к2, офис 5")).toBe("офис: [address]");
    expect(masked("ship to 221 Baker Street tomorrow")).toBe("ship to [address] tomorrow");
    expect(masked("кв. 7 в этом доме")).toBe("[address] в этом доме");
  });

  it("leaves ordinary text, dates, versions and amounts as they were", () => {
    for (const text of [
      "Всегда пиши отчёты по-русски, коротко и без воды",
      "релиз 0.1.196 вышел 2026-10-08 в 14:30, версия ядра vk.5",
      "счёт на 50 000 ₽ за SEO-сопровождение, срок 12 дней",
      "ticket #4521 closed after 3 retries and 1200 ms",
    ]) expect(masked(text), text).toBe(text);
  });

  it("says how many it masked, by kind, and never keeps the original", () => {
    const result = maskPii("пиши a@b.example и звони +7 916 123 45 67, ИНН 7707083893");
    expect(result.count).toBe(3);
    expect(result.kinds.sort()).toEqual(["email", "inn", "phone"]);
    expect(JSON.stringify(result)).not.toMatch(/a@b|916|7707083893/);
  });
});
