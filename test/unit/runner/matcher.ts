// `$opentide` from contrib/runner.json, applied the way VS Code applies a two-line problem pattern.
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { ROOT } from "../helpers";

interface Pattern {
  regexp: string;
  severity?: number;
  code?: number;
  message?: number;
  file?: number;
  line?: number;
  column?: number;
}

/** The `$opentide` problem matcher from contrib/runner.json, applied as VS Code applies a two-line pattern. */
export interface Problem {
  severity: string;
  code: string;
  message: string;
  file: string;
  line: number;
  column?: number;
}

export function matchProblems(text: string): Problem[] {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "contrib", "runner.json"), "utf8"));
  const matcher = manifest.contributes.problemMatchers.find((m: { name: string }) => m.name === "opentide");
  const [first, second] = matcher.pattern as [Pattern, Pattern];
  const header = new RegExp(first.regexp);
  const location = new RegExp(second.regexp);
  const lines = text.split(/\r?\n/);
  const out: Problem[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const h = header.exec(lines[i] ?? "");
    const l = h ? location.exec(lines[i + 1] ?? "") : null;
    if (!h || !l) continue;
    out.push({
      severity: h[first.severity ?? 0] ?? "",
      code: h[first.code ?? 0] ?? "",
      message: h[first.message ?? 0] ?? "",
      file: l[second.file ?? 0] ?? "",
      line: Number(l[second.line ?? 0]),
      ...(l[second.column ?? 0] ? { column: Number(l[second.column ?? 0]) } : {}),
    });
  }
  return out;
}
