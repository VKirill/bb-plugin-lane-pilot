#!/usr/bin/env python3
"""A-023 / A-017 / A-024 from the 2026-10-29 audit probe (evidence/claude-guard-boundaries.py)."""
from __future__ import annotations

import shlex

import hashlib
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lane-stack" / "hooks"))
import guard_shell as guard  # noqa: E402


class Decision(Exception):
    def __init__(self, code: int, message: str = "") -> None:
        self.code = code
        self.message = message


def verdict(command: str, role: str = "writer", cwd: str = "/fixture") -> tuple[int, str]:
    def allow(*_a: object) -> None:
        raise Decision(0)

    def deny(_client: object, message: str) -> None:
        raise Decision(2, message)

    payload = {
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "agent_type": role,
        "cwd": cwd,
        "session_id": "fixture",
    }
    with patch.object(guard, "read_payload", return_value=payload), patch.object(
        guard, "emit_allow", side_effect=allow
    ), patch.object(guard, "emit_deny", side_effect=deny), patch.dict(
        os.environ,
        {"LANE_PILOT_ROLE": "", "LANE_PILOT_AGENT_TYPE": "", "LANE_STACK_SESSION": ""},
    ):
        try:
            guard.main()
        except Decision as exc:
            return exc.code, exc.message
    raise AssertionError("guard emitted no verdict")


class GuardBoundaries(unittest.TestCase):
    def test_A023_git_global_options_preserve_force_push_ban(self) -> None:
        commands = [
            "git push --force origin main",
            "git -C /fixture push --force origin main",
            "git -c k=v push -f",
            "git --git-dir=x --work-tree=y push --force",
            "git --git-dir x --work-tree y push --force",
            "git --no-pager -P --bare -C /fixture push --force origin main",
        ]
        for command in commands:
            code, message = verdict(command)
            self.assertEqual(code, 2, f"{command}: {message}")
            self.assertIn("force", message.lower(), command)
        code, message = verdict("git -C /fixture push --force-with-lease origin main")
        self.assertEqual(code, 0, message)
        code, message = verdict("sudo git -C /fixture push --force origin main")
        self.assertEqual(code, 2, message)
        code, message = verdict("bash -c 'git -C /fixture push --force origin main'")
        self.assertEqual(code, 2, message)
        code, message = verdict("git -C /fixture commit -m x", role="errand")
        self.assertEqual(code, 2, message)
        self.assertIn("helper-guard", message)

    def test_A023_git_args_skip_globals_and_keep_push_arguments(self) -> None:
        self.assertEqual(
            guard._git_args("git -C /fixture push --force origin main", {"push"}),
            [["--force", "origin", "main"]],
        )
        self.assertEqual(
            guard._git_args("git -c k=v push -f", {"push"}),
            [["-f"]],
        )
        self.assertEqual(
            guard._git_args("git --git-dir=x --work-tree=y push --force", {"push"}),
            [["--force"]],
        )
        self.assertEqual(
            guard._git_args("sudo git -C /fixture push --force", {"push"}),
            [["--force"]],
        )
        self.assertEqual(
            guard._git_args("bash -c 'git -C /fixture push --force origin main'", {"push"}),
            [["--force", "origin", "main"]],
        )
        self.assertEqual(
            guard._git_args("git commit -q -F msg.txt && git push origin main", {"push"}),
            [["origin", "main"]],
        )
        self.assertEqual(
            guard._git_args("echo git push --force\ngit push --force origin main", {"push"}),
            [["--force", "origin", "main"]],
        )
        broken = "git -C /fixture push --force origin main '"
        found = guard._git_args(broken, {"push"})
        self.assertTrue(found and "--force" in found[0], found)

    def test_A017_plain_printed_git_is_data(self) -> None:
        code, message = verdict("echo git push --force origin main")
        self.assertEqual(code, 0, message)
        code, message = verdict("command echo git push --force origin main")
        self.assertEqual(code, 0, message)
        self.assertEqual(guard._git_args("echo git push --force origin main", {"push"}), [])
        self.assertEqual(guard._git_args("command echo git push --force origin main", {"push"}), [])
        self.assertEqual(guard._git_args("grep git push --force file", {"push"}), [])
        # A heredoc body inside `bash -c` is data, not a command (regression of the A-023 rewrite, caught by Claude Lane's test).
        script = "bash -c " + shlex.quote("cat <<'EOF'\ngit push --force origin main\nEOF")
        code, message = verdict(script)
        self.assertEqual(code, 0, message)
        self.assertEqual(guard._git_args(script, {"push"}), [])
        code, _ = verdict("bash -c " + shlex.quote("echo ready\ngit push --force origin main"))
        self.assertEqual(code, 2)

    def test_A024_permit_is_bound_to_reviewed_working_directory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="audit-permit-") as td, patch.object(
            guard, "PERMIT_DIR", pathlib.Path(td)
        ), patch.dict(os.environ, {"LANE_PILOT_ROLE": "writer"}):
            command = "rm customer-data.csv"
            category = "delete_for_good"
            session = "fixture"
            first = {"session_id": session, "cwd": "/fixture/scratch"}
            self.assertIsNotNone(guard._permit_or_ticket(first, command, category, "denied"))
            # The auditor's allow file: category + command, no directory. It must not authorize /fixture/live-data.
            digest = hashlib.sha256(f"{category}\n{command}".encode()).hexdigest()[:16]
            folder = pathlib.Path(td) / session
            (folder / f"{digest}.answer.json").write_text(json.dumps({"decision": "allow"}))
            result = guard._permit_or_ticket(
                {"session_id": session, "cwd": "/fixture/live-data"}, command, category, "denied"
            )
            self.assertIsNotNone(result)

    def test_A024_same_realpath_shares_one_grant(self) -> None:
        with tempfile.TemporaryDirectory(prefix="audit-permit-") as td, patch.object(
            guard, "PERMIT_DIR", pathlib.Path(td)
        ), patch.dict(os.environ, {"LANE_PILOT_ROLE": "writer"}):
            base = pathlib.Path(td) / "tree"
            scratch = base / "scratch"
            live = base / "live"
            scratch.mkdir(parents=True)
            live.mkdir()
            link = base / "alias"
            link.symlink_to(scratch, target_is_directory=True)
            via_dotdot = scratch / ".." / "scratch"
            command = "rm customer-data.csv"
            category = "delete_for_good"
            session = "fixture"

            def ask(cwd: str) -> str | None:
                return guard._permit_or_ticket(
                    {"session_id": session, "cwd": cwd}, command, category, "denied"
                )

            self.assertIsNotNone(ask(str(scratch)))
            self.assertIsNotNone(ask(str(link)))
            self.assertIsNotNone(ask(str(via_dotdot)))
            folder = pathlib.Path(td) / session
            tickets = list(folder.glob("*.ticket.json"))
            self.assertEqual(len(tickets), 1, [path.name for path in tickets])
            recorded = json.loads(tickets[0].read_text())["cwd"]
            self.assertEqual(os.path.realpath(recorded), os.path.realpath(scratch))
            answer = folder / f"{tickets[0].name.removesuffix('.ticket.json')}.answer.json"
            answer.write_text(json.dumps({"decision": "allow"}))
            self.assertIsNotNone(ask(str(live)))
            self.assertNotIn("used", json.loads(answer.read_text()))
            self.assertEqual(len(list(folder.glob("*.ticket.json"))), 2)
            self.assertIsNone(ask(str(link)))
            self.assertIn("used", json.loads(answer.read_text()))
            self.assertIsNotNone(ask(str(scratch)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
