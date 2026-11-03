// Theme colours for the canvas. Cytoscape draws on a canvas, so it gets the resolved values of the
// `--vscode-*` variables; this turns them into what it parses (it has no 8-digit hex). DOM-free.

export interface CanvasColor {
  /** `rgb(r, g, b)`, or the value as given when it is not a hex or rgb() colour. */
  readonly color: string;
  /** 0–1. */
  readonly opacity: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function canvasColor(value: string | undefined, fallback: string): CanvasColor {
  const text = (value ?? "").trim();
  if (!text) return fallback === "" ? { color: "rgb(128, 128, 128)", opacity: 1 } : canvasColor(fallback, "");
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex) {
    let digits = hex[1] as string;
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
    const r = Number.parseInt(digits.slice(0, 2), 16);
    const g = Number.parseInt(digits.slice(2, 4), 16);
    const b = Number.parseInt(digits.slice(4, 6), 16);
    const a = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
    return { color: `rgb(${r}, ${g}, ${b})`, opacity: Math.round(a * 1000) / 1000 };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(text);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map((part) => clamp(Math.round(Number(part)), 0, 255));
    const alphaText = rgb[4];
    const alpha =
      alphaText === undefined
        ? 1
        : alphaText.endsWith("%")
          ? Number(alphaText.slice(0, -1)) / 100
          : Number(alphaText);
    return { color: `rgb(${r}, ${g}, ${b})`, opacity: clamp(alpha, 0, 1) };
  }
  return { color: text, opacity: 1 };
}
