"""The drill lock: one holder at a time, a stale one is reclaimed."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

def take_lock(lock: Path) -> bool:
    """Takes the drill lock; a lock left by a process that no longer exists is stale and is taken over."""
    for _ in range(2):
        try:
            lock.mkdir()
            (lock / "pid").write_text(str(os.getpid()))
            return True
        except FileExistsError:
            try:
                os.kill(int((lock / "pid").read_text()), 0)
                return False
            except PermissionError:  # the process exists under another user
                return False
            except (OSError, ValueError):  # no pid file (a lock from before this check), a dead or unreadable pid
                shutil.rmtree(lock, ignore_errors=True)
    return False
