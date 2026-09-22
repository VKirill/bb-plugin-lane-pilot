import { connectOpencodeStack } from "../src/stack-ops";

const first = await connectOpencodeStack({
  requestedHostId: "host_7sea4qaad8",
  receiptDir: "/Users/vechkasov/Documents/BB-сервис/.bb/chats/thr_nn9e88jr2g/artifacts",
});
const second = await connectOpencodeStack({
  requestedHostId: "host_7sea4qaad8",
  receiptDir: "/Users/vechkasov/Documents/BB-сервис/.bb/chats/thr_nn9e88jr2g/artifacts",
});
console.log(JSON.stringify({
  firstSha: first.filesChanged[0]?.sha256After,
  secondSha: second.filesChanged[0]?.sha256After,
  same: first.filesChanged[0]?.sha256After === second.filesChanged[0]?.sha256After,
  secondNotes: second.notes,
}, null, 2));
