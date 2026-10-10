"""Runs lane-stack/hooks/guard_shell.py once per request in a forked child of a warm interpreter (tests/guard-pool.ts).

A fresh `python3 guard_shell.py` costs about 50 ms of CPU, almost all of it interpreter start, imports and compiling the 1 600-line
script; a test that checks 100 command forms paid it 100 times. Here the interpreter starts once, the stdlib and lib_payload are
imported once and the script is compiled once; every request forks, replaces the environment and stdin, and executes the compiled
script as `__main__` in the child, so each run still starts from a clean module state exactly like a new process would.

Protocol: one JSON object per line on stdin {"id", "input", "env"}; one JSON line back {"id", "status", "stdout", "stderr"}.
"""
import io
import json
import os
import sys

guard = sys.argv[1]
sys.path.insert(0, os.path.dirname(guard))
import ipaddress, re, shlex, socket, threading  # noqa: E401,F401  (warm: the guard imports them)
import lib_payload  # noqa: F401

with open(guard, encoding="utf-8") as handle:
    code = compile(handle.read(), guard, "exec")


def run_child(request, write_fd):
    status, out, err = 0, "", ""
    stdout, stderr = io.StringIO(), io.StringIO()
    try:
        os.environ.clear()
        os.environ.update(request["env"])
        sys.stdin = io.StringIO(request["input"])
        sys.stdout, sys.stderr = stdout, stderr
        try:
            exec(code, {"__name__": "__main__", "__file__": guard})
        except SystemExit as stop:
            status = stop.code if isinstance(stop.code, int) else (0 if stop.code is None else 1)
    except BaseException as error:  # a crash in the guard is a crash of the run, as it would be of the process
        status = 1
        stderr.write(repr(error))
    out, err = stdout.getvalue(), stderr.getvalue()
    os.write(write_fd, json.dumps({"id": request["id"], "status": status, "stdout": out, "stderr": err}).encode() + b"\n")


for line in sys.stdin:
    if not line.strip():
        continue
    request = json.loads(line)
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            run_child(request, write_fd)
        finally:
            os._exit(0)
    os.close(write_fd)
    chunks = []
    while True:
        chunk = os.read(read_fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(read_fd)
    _, wait_status = os.waitpid(pid, 0)
    reply = b"".join(chunks)
    if not reply:  # the child died without a word (os._exit or a signal inside the guard)
        reply = json.dumps({"id": request["id"], "status": None, "stdout": "", "stderr": f"child ended with wait status {wait_status}"}).encode() + b"\n"
    sys.__stdout__.write(reply.decode())
    sys.__stdout__.flush()
