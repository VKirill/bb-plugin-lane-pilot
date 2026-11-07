import { parseJsonOr } from "@lane-pilot/kit";

export function parseSandboxUnsafePatterns(settingValue: unknown): string[] {
  if (Array.isArray(settingValue)) {
    return settingValue.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof settingValue === "string") {
    const trimmed = settingValue.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const parsed = parseJsonOr<unknown>(trimmed, null);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
    return trimmed.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

/** Flags of vitest/jest that take a value: that value is not a test filter. */
const VALUE_FLAGS = new Set(["--exclude", "-x", "--config", "-c", "--root", "-r", "--reporter", "--project", "--dir", "--environment", "--testNamePattern", "-t", "--outputFile", "--shard",
  "--pool", "--retry", "--testTimeout", "--hookTimeout", "--bail", "--maxWorkers", "--minWorkers", "--maxConcurrency", "--workspace", "--mode"]);

/** Positional arguments a vitest/jest run, or an npm/pnpm/yarn script after «--», receives. */
export function runnerFilterArgs(command:string):string[] {
  const found:string[] = [];
  for (const part of command.split(/&&|;|\|\|/)) {
    const tokens = part.trim().split(/\s+/);
    let from = tokens.findIndex((token) => /(?:^|\/)(?:vitest|jest)$/.test(token));
    if (from < 0 && /^(?:npm|pnpm|yarn)$/.test(tokens[0] ?? "")) from = tokens.indexOf("--");
    if (from < 0) continue;
    for (let i = from + 1; i < tokens.length; i++) {
      const token = tokens[i]!.replace(/^["']|["']$/g, "");
      if (VALUE_FLAGS.has(token)) { i++; continue; }
      if (/^[\w@.][\w@./-]*$/.test(token) && !token.startsWith("--")) found.push(token);
    }
  }
  return found;
}

export function findSandboxUnsafeMissingExcludes(command: string, patterns: readonly string[]): string[] {
  if (!patterns.length) return [];
  const value = command.trim();
  if (!value) return [];
  const isVitestCommand = /(?:^|[;&|]\s*)(?:npx\s+)?vitest(?:\s+run)?(?:\s+|$)/i.test(value);
  if (!isVitestCommand) return [];
  // A positional filter outside --exclude/-x makes it a focused check
  const strippedOfExcludes = value.replace(/(?:--exclude(?:=|\s+)|-x\s+)(?:'[^']+'|"[^"]+"|\S+)/g, "");
  // A file, a folder («tests/server/») or any word after the subcommand narrows the run; value flags (--pool forks, --retry 2) do not.
  if (runnerFilterArgs(strippedOfExcludes).some((arg) => !/^(?:run|watch|dev|bench|list|\.|\.\/)$/.test(arg))) return [];

  // Parse existing --exclude flags
  // Flags can be --exclude <val>, --exclude=<val>, or -x <val>
  const excludeMatches = [...value.matchAll(/(?:--exclude(?:=|\s+)|-x\s+)(?:'([^']+)'|"([^"]+)"|(\S+))/g)];
  const existingExcludes = new Set<string>();
  for (const match of excludeMatches) {
    const glob = match[1] ?? match[2] ?? match[3];
    if (glob) existingExcludes.add(glob.trim());
  }
  return patterns.filter((pattern) => !existingExcludes.has(pattern));
}
/** Flags that narrow a pytest run without a path: by name, marker or changed files. */
const PYTEST_VALUE_FLAGS=new Set(["-k","-m","-c","-p","-o","--rootdir","--tb","--junitxml","--durations","--maxfail","--ignore","--deselect","--confcutdir","--basetemp","-n"]);
export function runsWholeSuite(command:string):boolean {
  for(const part of command.split(/&&|;|\|\||\|/)) {
    const value=part.trim();
    if(!value)continue;
    const tokens=value.split(/\s+/);
    const bin=tokens.findIndex((token)=>/(?:^|\/)(?:vitest|jest)$/.test(token));
    if(bin>=0) {
      const rest=tokens.slice(bin+1);
      if(rest.some((token)=>/^(?:-t|--testNamePattern(?:=.*)?|--changed(?:=.*)?|--related|--onlyChanged|--findRelatedTests)$/.test(token)))continue;
      if(runnerFilterArgs(part).some((arg)=>!/^(?:run|watch|dev|bench|list|\.|\.\/)$/.test(arg)))continue;
      return true;
    }
    const py=tokens.findIndex((token,index)=>/(?:^|\/)(?:pytest|py\.test)$/.test(token)||(token==="-m"&&tokens[index+1]==="pytest"));
    if(py>=0) {
      const rest=tokens.slice(tokens[py]==="-m"?py+2:py+1);
      let focused=false;
      for(let i=0;i<rest.length;i++) {
        const token=rest[i]!;
        if(/^(?:-k|-m)$/.test(token)||/^(?:-k|-m)\S/.test(token)||/^--(?:lf|last-failed|sw|stepwise)$/.test(token)){focused=true;break;}
        if(PYTEST_VALUE_FLAGS.has(token)){i++;continue;}
        if(!token.startsWith("-")){focused=true;break;}
      }
      if(!focused)return true;
      continue;
    }
    // `npm test`, `npm run test`, `pnpm test`, `yarn test`, `bun run test`: the whole script unless it gets arguments or names a workspace.
    const script=/^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:test|t)(?:\s|$)/.exec(value);
    if(script) {
      const rest=value.slice(script[0].length).trim().split(/\s+/).filter(Boolean);
      if(rest.includes("--")&&rest.indexOf("--")<rest.length-1)continue;
      if(rest.some((token)=>!token.startsWith("-")||/^(?:-w|-C|-F|--workspaces?|--prefix|--filter)(?:=|$)/.test(token)))continue;
      return true;
    }
  }
  return false;
}

const PIPE_OR_REDIRECT = /(?:^|[^|])\|(?!\|)|\|\||[><`]|\\\s*\n/;

/** The chain's segments, or null when the command is not a plain `&&`/`;` sequence. */
function chainSegments(command: string): string[] | null {
  if (PIPE_OR_REDIRECT.test(command)) return null;
  const parts = command.split(/&&|;|\n/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * The chain as one command, or null when it cannot be glued safely. Two segments merge only when they have the same
 * token count and differ in positions where every segment holds a non-flag token that is not a flag's value — i.e.
 * positional filter arguments, which a test runner unions. Anything else keeps the chain.
 */
export function gluedCheckCommand(command: string): string | null {
  const parts = chainSegments(command);
  if (!parts || parts.length < 2) return null;
  const unique = [...new Set(parts)];
  if (unique.length === 1) return unique[0]!;
  const rows = unique.map((part) => part.split(/\s+/));
  const width = rows[0]!.length;
  if (!rows.every((row) => row.length === width)) return null;
  const diffCols: number[] = [];
  for (let col = 0; col < width; col++) {
    if (new Set(rows.map((row) => row[col])).size > 1) diffCols.push(col);
  }
  for (const col of diffCols) {
    const prev = rows[0]![col - 1];
    if (prev === undefined || diffCols.includes(col - 1)) return null;
    // A `--flag value` diff is the flag's value (union or override is the runner's); a `--flag=value` token is self-contained.
    if ((prev.startsWith("-") && !prev.includes("=")) || rows.some((row) => row[col]!.startsWith("-"))) return null;
  }
  const extra = diffCols.flatMap((col) => rows.slice(1).map((row) => row[col]!));
  return [...rows[0]!, ...extra].join(" ");
}
