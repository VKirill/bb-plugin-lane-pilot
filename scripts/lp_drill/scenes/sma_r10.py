"""Region 10 · Telegram — the region scene of the SMA map (docs/sma-evidence.md, «Trace choice»); it also proves n818 of region 9, the window's door to the bot.

The code of these nodes is the Telegram plugin (bb-plugin-telegram-projects, version 0.12.0 in its source; the hub runs 0.5.2 and it is disabled
there), a sibling repository. sma_r10_probe.ts runs the REAL plugin code of the sibling worktree (SMA_SIBLING_TELEGRAM, else the proofs worktree) on
the SDK's fake plugin host against a STAND-IN Bot API: a fake fetch, so no request leaves the machine, no real Telegram, no hub, no model, no
BB CLI. Every line below compares what the plugin did with the node's card and says in its detail that the API was a stand-in.
What a stand-in cannot show is listed under NOT_PROVED: that the real Telegram accepts the requests, and anything that needs the plugin enabled
on the hub with the owner's bot. Run: scripts/lp-drill.sh --scenario sma_r10.
"""
from __future__ import annotations

import json
import subprocess

from lp_drill.env import ROOT
from lp_drill.prove import Proofs

NODES = ["n818", "n960", "n961", "n962", "n963", "n964", "n965", "n966", "n967", "n968", "n969", "n970", "n972", "n973", "n974", "n975", "n976", "n977", "n978", "n979", "n980", "n981", "n982"]
PROBE = ROOT / "scripts/lp_drill/scenes/sma_r10_probe.ts"
STAND_IN = "stand-in Bot API"
CODE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
NOT_PROVED = ("whether the real Telegram accepts these requests and shows the typing sign, and how the plugin behaves enabled on the hub with the owner's bot: "
              "the hub's plugin is 0.5.2 and disabled, the source is 0.12.0")


def scenario_sma_r10(tmp) -> dict:
    proofs = Proofs()
    done = subprocess.run(["npx", "tsx", str(PROBE)], cwd=ROOT, capture_output=True, text=True, timeout=300)
    try:
        s = json.loads(done.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return proofs.verdict("sma_r10", [f"the probe printed no result (exit {done.returncode}): {(done.stderr or done.stdout).strip()[-300:]}"])
    if "absent" in s:
        return proofs.verdict("sma_r10", [f"{s['absent']}: nothing of region 10 could be run"], notProved={n: s["absent"] for n in NODES})
    link, null, poll, route, bridge, wake, client, chat = s["link"], s["null"], s["poll"], s["route"], s["bridge"], s["wake"], s["client"], s["chat"]

    # n818 The window's door «Telegram bot»: the plugin's pairing call hands out a code while nobody is paired and nothing once someone is.
    o = link["offer"]
    ok = o["owner"] is None and len(o["code"]) == 8 and link["afterPair"] == {"owner": 4242, "code": None, "link": None}
    proofs.prove("n818", ok, f"{STAND_IN}: pairing before {o}, after a chat is paired {link['afterPair']}")

    # n960 The bridge is built from the current settings: held back while chat is on but no bridge exists, built when the service runs, taken down on a switch-off.
    ok = bridge["heldCalls"] == 0 and bridge["built"] and bridge["polled"] and bridge["rows"] == ["chat:in:1"] and bridge["down"]
    proofs.prove("n960", ok, f"{STAND_IN}: requests while no bridge existed {bridge['heldCalls']}, bridge published on {bridge['built']}, then polled {bridge['polled']} and took in {bridge['rows']}, taken down on chat off {bridge['down']}")

    # n961 No bot — no loop: switched off or without a token the plugin asks Telegram for nothing.
    ok = null["calls"] == 0 and null["state"] == [] and null["link"] == "off" and null["error"] == "bot_configuration_unavailable"
    proofs.prove("n961", ok, f"{STAND_IN}: requests {null['calls']}, stored keys {null['state']}, link {null['link']}; on without a token: {null['error']}")

    # n962 Long polling: 25 s wait from the stored position, the round's own ceiling above the wait.
    want = {"timeout": 25, "allowed_updates": ["message", "callback_query"]}
    ok = poll["bodies"] == [{"offset": 0, **want}, {"offset": 8, **want}] and poll["deadlines"] == [40000, 40000]
    proofs.prove("n962", ok, f"{STAND_IN}: poll requests {poll['bodies']}, ceilings {poll['deadlines']} ms")

    # n963 Backoff after a failure: doubling pauses up to a ceiling, a good poll starts over. The plugin's numbers are 10 s up to 5 min (the card says 5 s up to a minute).
    ok = poll["delays"] == [10000, 20000, 40000, 80000, 160000, 300000, 300000, 10000] and poll["error"] == "telegram_network"
    proofs.prove("n963", ok, f"{STAND_IN}: pauses after failures {[d // 1000 for d in poll['delays']]} s (the card says 5 s doubling to 60 s)")

    # n964 A stranger's chat gets one sentence, once each; nothing reaches the conversation, no BB call, the owner stays.
    st = route["stranger"]
    ok = st["sent"] == [[99, route["sentence"]], [100, route["sentence"]]] and st["rows"] == [] and st["sdk"] == 0 and st["owner"] == 4242
    proofs.prove("n964", ok, f"{STAND_IN}: two strangers, three messages -> {st['sent']}, conversation rows {st['rows']}, BB calls {st['sdk']}")

    # n965 Pairing code from the chat: the live code from a private chat pairs it; a wrong code, a group and an expired code pair nobody.
    p = route["pair"]
    ok = p["before"] == {"owner": None, "sent": 0} and p["owner"] == 55 and p["codeLeft"] is None and route["expired"] is None
    proofs.prove("n965", ok, f"{STAND_IN}: wrong code, group and bare /start paired {p['before']}; the right one paired {p['owner']}; code left {p['codeLeft']}; an 11-minute-old code paired {route['expired']}")

    # n966 Chat paired: from then on its words reach the conversation and a stranger's do not.
    w = route["words"]
    ok = w["reached"] and w["owner"] == 55 and w["rows"] == ["chat:in:2"] and w["row"] == [55, 55] and w["to66"] == [route["sentence"]]
    proofs.prove("n966", ok, f"{STAND_IN}: after pairing 55 the bridge took in {w['rows']} for {w['row']}, answered the chat {w['to55']} times (confirmation + its own word); the stranger got {w['to66']}")

    # n967 Not text: a sticker is refused politely by the router and the loop; a photo reaches the bridge without words and is refused there.
    at = chat["attachment"]
    ok = (chat["sticker"] == {"kind": "refuse", "topicId": 0} and route["refused"] == [[7, "Я читаю текст, голосовые, фото и файлы. Напиши словами, что сделать."]]
          and at["kind"] == "chat" and at.get("text") is None and at["started"] == 0 and at["said"] == ["Отправь текст или голосовое сообщение. Вложения пока открывай в BB."])
    proofs.prove("n967", ok, f"{STAND_IN}: sticker -> {chat['sticker']['kind']} and answer {route['refused']}; photo -> chat without text, chats started {at['started']}, answer {at['said']} (voice is transcribed, not refused)")

    # n968 The same brain as the window: the first message starts a visible BB chat with the owner's words, the next goes into the same chat.
    b = chat["brain"]
    ok = b == [["spawn", "Собери мне лендинг", "visible"], ["send", [{"type": "text", "text": "И добавь форму", "mentions": []}], "thr_one"]]
    proofs.prove("n968", ok, f"stand-in BB: {b}")

    # n969 Conversation not connected: the link works, the owner's words get one explanation an hour and never reach the conversation.
    nb = route["noBrain"]
    ok = nb["first"] == ["Общение с BB из Telegram выключено. Включи его на странице плагина Telegram Projects."] and nb["rows"] == [] and nb["second"] == 2 and nb["link"] == "linked"
    proofs.prove("n969", ok, f"{STAND_IN}: two messages -> {len(nb['first'])} explanation, conversation rows {nb['rows']}, an hour later {nb['second']} in all, link {nb['link']}")

    # n970 The typing sign: none while idle, one while the chat works, renewed after 5 s and not after 4 s (the card says every 4 s; the plugin renews after more than 4.5 s).
    ok = chat["signs"] == [0, 1, 1, 2]
    proofs.prove("n970", ok, f"stand-in BB, recording Telegram: signs idle / working / +4 s / +5 s = {chat['signs']}")

    # n972 A draft waits for «yes» (setting confirmNewChat): kept, replaced by other words, started by a whole «да» with the draft's words.
    d = chat["draft"]
    ok = d["waiting"] == {"started": 0, "draft": "Напиши стихотворение"} and d["started"] == [["spawn", "Лучше напиши рассказ"]] and d["left"] is False
    proofs.prove("n972", ok, f"stand-in BB with confirmNewChat on: {d}")

    # n973 Bot API client: JSON to the bot's method, the owner's chat on chat calls, none on the bot's own calls, a deadline of its own.
    want = [["getUpdates", {"offset": 0, "timeout": 25}, 12345], ["sendMessage", {"text": "hi", "message_thread_id": 7, "chat_id": 4242}, 12345],
            ["sendMessage", {"text": "hey", "chat_id": 99}, 12345], ["sendChatAction", {"action": "typing", "chat_id": 4242}, 12345], ["getMe", {}, 12345]]
    proofs.prove("n973", client["shapes"] == want, f"{STAND_IN}: requests {client['shapes']}")

    # n974 Token cut out: a network failure naming the address, a broken answer and a refusal become a bare code with no token.
    proofs.prove("n974", client["errors"] == ["telegram_network:false", "telegram_invalid_response:false", "telegram_401:false"], f"{STAND_IN}: errors (code:token-in-it) {client['errors']}")

    # n975 Connect the bot from the window: the token goes in, a code is issued, the bot is disconnected; the token never comes out.
    ok = link["tokenBefore"] == [False, "none"] and link["tokenAfter"] == [True, "manual"] and link["saved"] == [True, "sma_bot"] and link["leaked"] is False and link["unpaired"] is True and link["requestTokens"] == ["654321:NEWtokenABCDEFGHIJKLMNOPQRSTUV"]
    proofs.prove("n975", ok, f"{STAND_IN}: token {link['tokenBefore']} -> {link['tokenAfter']}, saved {link['saved']}, token in anything the window reads {link['leaked']}, disconnected {link['unpaired']}")

    # n976 Pairing code: 8 characters from an alphabet without look-alikes, ten minutes.
    ok = len(o["code"]) == 8 and all(c in CODE for c in o["code"]) and link["same"] and link["mintClock"]["nine"] == o["code"] and link["mintClock"]["ten"] != o["code"]
    proofs.prove("n976", ok, f"code {o['code']}, the same at 9.5 min {link['mintClock']['nine'] == o['code']}, a new one at 10 min {link['mintClock']['ten']}")

    # n977 Link view without the token: the link opens the bot with the code; no token in what the window reads.
    ok = o["link"] == f"https://t.me/sma_bot?start={o['code']}" and link["leaked"] is False and link["afterPair"]["link"] is None
    proofs.prove("n977", ok, f"{STAND_IN}: link {o['link']}, token in the views {link['leaked']}, link once paired {link['afterPair']['link']}")

    # n978 Off, awaiting code, linked.
    proofs.prove("n978", link["states"] == ["off", "awaiting_code", "linked"], f"{STAND_IN}: link states {link['states']}")

    # n979 Bridge rebuilt at once: the chat bridge is built, taken down and rebuilt by settings changes with no restart; a setting change wakes the sync loop at once.
    ok = bridge["down"] and bridge["rebuilt"] and bridge["off"] and wake == {"quiet": 1, "woke": True, "quick": True}
    proofs.prove("n979", ok, f"{STAND_IN}: bridge off {bridge['down']}, on again {bridge['rebuilt']}, off with the plugin switched off {bridge['off']}; sync rounds before the change {wake['quiet']}, woken within 2.5 s {wake['woke']}")

    # n980 Write the token and code: the token goes into the bot's own setting, the code is stored once and kept.
    ok = link["stored"] == {"code": o["code"], "at": "number"} and link["tokenAfter"] == [True, "manual"] and link["same"]
    proofs.prove("n980", ok, f"{STAND_IN}: stored code {link['stored']}, token setting {link['tokenAfter']}")

    # n981 Write the paired chat: the chat that sent the code is the owner; a stranger and a wrong code are not.
    ok = p["owner"] == 55 and w["owner"] == 55 and link["linked"] == ["linked", 4242]
    proofs.prove("n981", ok, f"{STAND_IN}: owner after the code {p['owner']} (a wrong code, a group and a bare /start left it {p['before']['owner']})")

    # n982 Disconnect the bot: the paired chat is forgotten, the link goes back to awaiting a code.
    ok = link["unpaired"] is True and link["gone"] == ["awaiting_code", None]
    proofs.prove("n982", ok, f"{STAND_IN}: after disconnecting link {link['gone']}")

    return proofs.verdict("sma_r10", checked=len(NODES))
