import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOOKS_DIR = join(process.cwd(), "lane-stack/hooks");

const AST_CHECK = `
import ast, json, pathlib, sys

violations = []
for file in sys.argv[1:]:
    src = pathlib.Path(file).read_text(encoding="utf-8")
    tree = ast.parse(src, filename=file)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = None
        if isinstance(func, ast.Attribute) and func.attr in {"read_text", "write_text", "open"}:
            # Skip os.open(...) which takes integer flags and returns a file descriptor.
            if func.attr == "open" and isinstance(func.value, ast.Name) and func.value.id == "os":
                continue
            name = func.attr
        elif isinstance(func, ast.Name) and func.id == "open":
            name = "open"
        elif isinstance(func, ast.Attribute) and func.attr == "fdopen" and isinstance(func.value, ast.Name) and func.value.id == "os":
            name = "os.fdopen"
        if not name:
            continue
        has_encoding = any(kw.arg == "encoding" for kw in node.keywords)
        # Positional mode arg: open(path, mode), Path.open(mode), os.fdopen(fd, mode)
        mode_arg = None
        if name == "open" and len(node.args) >= 2 and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str):
            mode_arg = node.args[1].value
        elif name == "open" and any(kw.arg == "mode" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str) for kw in node.keywords):
            mode_arg = next(kw.value.value for kw in node.keywords if kw.arg == "mode")
        elif isinstance(func, ast.Attribute) and func.attr == "open" and len(node.args) >= 1 and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            mode_arg = node.args[0].value
        elif name == "os.fdopen" and len(node.args) >= 2 and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str):
            mode_arg = node.args[1].value
        if mode_arg and "b" in mode_arg:
            continue
        if not has_encoding:
            violations.append(f"{pathlib.Path(file).name}:{node.lineno} {name}() missing encoding=")

print(json.dumps(violations))
`;

describe("lane-stack/hooks/*.py text I/O encoding", () => {
  it("passes explicit encoding= on every read_text(), write_text(), and text open() call", () => {
    const files = readdirSync(HOOKS_DIR)
      .filter((name) => name.endsWith(".py"))
      .sort()
      .map((name) => join(HOOKS_DIR, name));
    expect(files.length).toBeGreaterThan(0);
    const res = spawnSync("python3", ["-c", AST_CHECK, ...files], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    const violations = JSON.parse(res.stdout) as string[];
    expect(violations).toEqual([]);
  });
});
