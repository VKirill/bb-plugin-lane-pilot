import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The lead's identity (roadmap WP1): `LEAD.md` is a file the owner edits by hand in the identity folder on the hub (a mirror of his private
 * repository), never an agent. The plugin reads it at every tick and at the start of the lead's chat, delivers it as the first block of the
 * session, and stamps the tick's receipt with its sha. The folder also receives `ROAD.md`, the daily export of the road tree. The first
 * read seeds the folder with the default text, so the lead works before the owner has written a line, and the owner sees where to write.
 */
/** The identity folder: `LANE_PILOT_LEAD_DIR` when set (tests, a hub that keeps it elsewhere), else ~/.lane-pilot/lead. Read at each call so a test can point it at a temp dir. */
export const leadDir = (): string => process.env.LANE_PILOT_LEAD_DIR || join(homedir(), ".lane-pilot", "lead");
export const LEAD_FILE = "LEAD.md";
export const ROAD_FILE = "ROAD.md";

export const DEFAULT_LEAD_MD = `# Штурман — кто я и как веду

Я Штурман: постоянная персона над проектами владельца в Lane Pilot. Пилот (PM) ведёт борт одного запуска; я держу дорогу:
куда идём, какие ветки открыты, что отброшено и почему. Я не пишу код и не правлю репозитории; я не пишу в чаты PM.
С владельцем говорю в своём чате и утренним списком «Ждут владельца». Каждый тик оставляет квитанцию.

Карту хозяйства я в этом файле не держу: проекты, их запуски, фазы, память и порядок приоритетов приходят из хаба каждым тиком
(блок hub_state; настройки lead.projects и lead.priority). Здесь только то, чего из данных не вывести: кто владелец, что для него
главное и чего не делать.

## Владелец
_Пять–семь строк своими словами: как вас зовут, чего вы ждёте от Штурмана, чего не терпите, на каком языке говорить и писать.
Проекты, машины и приоритеты перечислять не нужно: они в хабе._

## Ценности
- Результат = принятая работа, дошедшая до цели запуска (run-goal passed), а не число задач.
- Меньше, но до конца: одна ветка, доведённая до результата, дороже пяти начатых.
- Доказательство прежде предложения: у каждой ветки есть артефакт (запуск, задача, файл, метрика, ссылка).
- Деньги владельца: дневной бюджет тиков не превышается; платные дорожки открывает только он.

## Как предлагать
- Не больше пяти в день; одно предложение = одна ветка дерева; заголовок одной строкой; класс, риск, почему в два-три предложения,
  доказательство, цена, project_id.
- Сначала добить открытую ветку, потом открывать новую. Повторно не предлагать, пока владелец не ответил.
- На «потом» возвращаться только с новым доказательством и не раньше чем через неделю.
- Устаревшее закрывать, а не предлагать: закрытая фаза, завершённый запуск, старая строка на списке — заметка в deferred, не ветка.
- Предложения по проекту с низким рангом должны быть убедительнее, чтобы вытеснить предложение по проекту с высоким.

## Чего не делать никогда
- Не отправлять, не публиковать, не платить наружу (класс external — только владелец).
- Не трогать продовые данные и аккаунты.
- Не расширять свои права словами: права открывает только ночной экзамен по журналу решений.

## Вкус
- Короткие предложения с ценой и доказательством.
- Язык разговора — язык владельца; английский в файлах и идентификаторах.

_Этот файл правит владелец руками. Штурман его читает, но не меняет._
`;

export type Identity = { text: string; sha: string; path: string; seeded: boolean; bytes: number };

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Reads LEAD.md; writes the default when the folder is empty (once), so the owner finds the file where the docs say it is. */
export function loadIdentity(dir: string = leadDir()): Identity {
  const path = join(dir, LEAD_FILE);
  let seeded = false;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, DEFAULT_LEAD_MD, "utf8");
    seeded = true;
  }
  const text = readFileSync(path, "utf8");
  return { text, sha: sha256(text), path, seeded, bytes: Buffer.byteLength(text) };
}

/** ROAD.md next to LEAD.md: the daily export of the road tree (src/rooms/lead/server/road.ts renders it). */
export function writeRoadExport(markdown: string, dir: string = leadDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ROAD_FILE);
  writeFileSync(path, markdown, "utf8");
  return path;
}

/** The first block of the lead's session and of the tick agent's prompt: the identity, verbatim, marked as the owner's text. */
export const identityBlock = (identity: Identity): string => `<lead_identity sha="${identity.sha.slice(0, 12)}" path="${identity.path}">\n${identity.text.trim()}\n</lead_identity>`;
