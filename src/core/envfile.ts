// A small `.env` parser for `opentide.envFile`. vscode-free.

/**
 * Parse `KEY=value` lines: `export` prefixes, `#` comments, single quotes (literal), double quotes (with
 * `\n`, `\t`, `\"` and `\\` escapes). `${VAR}` is not expanded. Invalid lines are skipped.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!match?.[1]) continue;
    const key = match[1];
    let value = match[2] ?? "";
    if (value.startsWith('"')) {
      // A double-quoted value may span lines.
      let body = value.slice(1);
      while (findClosingQuote(body) < 0 && i + 1 < lines.length) body += `\n${lines[++i] ?? ""}`;
      const end = findClosingQuote(body);
      body = end >= 0 ? body.slice(0, end) : body;
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
  return out;
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
