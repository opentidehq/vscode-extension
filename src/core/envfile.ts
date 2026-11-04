// A small `.env` parser for `opentide.envFile`. vscode-free.
import * as fs from "node:fs";

export interface EnvFile {
  readonly variables: Record<string, string>;
  /** 1-based lines that were not read: neither blank, a comment nor `KEY=value`, or a `"` never closed. */
  readonly skipped: readonly number[];
}

/**
 * Parse `KEY=value` lines: `export` prefixes, `#` comments, single quotes (literal), double quotes (with
 * `\n`, `\t`, `\"` and `\\` escapes). `${VAR}` is not expanded. Invalid lines are skipped. A double
 * quote that is never closed drops its key, and parsing resumes on the next line, so the variables
 * after it are still read and none of them becomes part of its value.
 */
export function parseEnvFile(text: string): Record<string, string> {
  return readEnvFile(text).variables;
}

/** {@link parseEnvFile}, with the lines it skipped. */
export function readEnvFile(text: string): EnvFile {
  const out: Record<string, string> = {};
  const skipped: number[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!match?.[1]) {
      if (raw.trim() !== "" && !raw.trim().startsWith("#")) skipped.push(i + 1);
      continue;
    }
    const key = match[1];
    let value = match[2] ?? "";
    if (value.startsWith('"')) {
      // A double-quoted value may span lines.
      let body = value.slice(1);
      let last = i;
      while (findClosingQuote(body) < 0 && last + 1 < lines.length) body += `\n${lines[++last] ?? ""}`;
      const end = findClosingQuote(body);
      if (end < 0) {
        skipped.push(i + 1);
        continue;
      }
      i = last;
      body = body.slice(0, end);
      value = body.replace(/\\([nrt"\\])/g, (_, c: string) =>
        c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
      );
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end >= 0 ? value.slice(1, end) : value.slice(1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[key] = value;
  }
  return { variables: out, skipped };
}

/**
 * The variables of the env file at `file`, telling `warn` which lines it skipped, or that it could not
 * be read (then none).
 */
export function loadEnvFile(file: string, warn: (message: string) => void): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    warn(
      `opentide.envFile: could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
  const { variables, skipped } = readEnvFile(text);
  if (skipped.length > 0)
    warn(
      `opentide.envFile: skipped line${skipped.length === 1 ? "" : "s"} ${skipped.join(", ")} of ${file} (not KEY=value, or a double quote never closed)`,
    );
  return variables;
}

function findClosingQuote(body: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] === '"') return i;
  }
  return -1;
}
