// JSON with comments and trailing commas (VS Code's `.vscode/mcp.json`), parsed leniently. vscode-free.

/** Copy `text`, calling `other` for each character outside a string; strings are copied as they are. */
function scan(text: string, other: (i: number, out: string[]) => number): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out.push(text.slice(i, j + 1));
      i = j + 1;
    } else {
      i = other(i, out);
    }
  }
  return out.join("");
}

/** `text` without `//` and `/* *\/` comments and trailing commas; strings are left as they are. */
export function stripJsonc(text: string): string {
  const uncommented = scan(text, (i, out) => {
    if (text[i] === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") j++;
      return j;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      return end < 0 ? text.length : end + 2;
    }
    out.push(text[i] ?? "");
    return i + 1;
  });
  return scan(uncommented, (i, out) => {
    if (uncommented[i] === ",") {
      let j = i + 1;
      while (j < uncommented.length && /\s/.test(uncommented[j] ?? "")) j++;
      if (uncommented[j] === "}" || uncommented[j] === "]") return i + 1;
    }
    out.push(uncommented[i] ?? "");
    return i + 1;
  });
}

/** The parsed value, or undefined when the text is not JSON(C). */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text.replace(/^﻿/, "")));
  } catch {
    return undefined;
  }
}
