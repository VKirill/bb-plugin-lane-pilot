// Region 8 · Daemon front outside the graphs — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, voidIsHave, voidStays } from "./types";

export default {

  n695: { voidReview: voidIsHave("реестр подключений MCP на машине держат BB и MetaMCP; какие серверы получает роль, задаёт профиль роли (mcpServers, обязательные серверы), переключатель — n696") },
  n703: { voidReview: voidStays("блока домохозяйства нет: машины и единственный хаб принадлежат ядру BB, плагин берёт hostId у BB, и поведения от самообъявленной роли нет") },
  n710: { voidReview: voidStays("нет адреса, приходящего от пира: хосты приходят из регистрации BB, единственный внешний адрес events.webhook_url задаёт владелец (только https), SSRF-входа нет") },
  n714: { voidReview: voidIsHave("назначение «на пира можно передать только разрешённые действия» выполняет закрытый контракт хоста: фиксированный список методов, слова ворот в него не входят (n688)") },
  n744: { voidReview: voidStays("по собственной карте SMA значение стиля осталось без экрана и никем не читается; факты стиля живут в DESIGN.md") },
  n750: { voidReview: voidIsHave("публикация требует квитанции зелёного полного прогона, ключённой по дереву и версии node и лежащей на диске (переживает рестарт), — предела SMA «только в памяти» нет") },
} satisfies RegionEvidence;
