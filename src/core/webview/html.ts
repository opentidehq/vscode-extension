// The page of every opentide webview: strict CSP, nonce scripts, no remote resources. vscode-free.
import { randomBytes } from "node:crypto";

export function nonce(): string {
  return randomBytes(18).toString("base64").replace(/[+/=]/g, "");
}

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** The Content-Security-Policy of every opentide webview: nothing remote, scripts only with the nonce. */
export function contentSecurityPolicy(cspSource: string, scriptNonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    `style-src ${cspSource} 'nonce-${scriptNonce}'`,
    `script-src 'nonce-${scriptNonce}'`,
  ].join("; ");
}

export function renderHtml(options: {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  title: string;
  nonce: string;
  /** More stylesheets from the extension, after base.css: the codicon font, the panels kit. */
  extraStyleUris?: readonly string[];
  /** The panels kit's page class (`ot-kit`): its type scale, spacing and focus rings apply. */
  bodyClass?: string;
}): string {
  const extra = (options.extraStyleUris ?? [])
    .map((uri) => `\n<link rel="stylesheet" href="${uri}" nonce="${options.nonce}">`)
    .join("");
  const bodyClass = options.bodyClass ? ` class="${escapeHtml(options.bodyClass)}"` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(options.cspSource, options.nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${options.styleUri}" nonce="${options.nonce}">${extra}
<title>${escapeHtml(options.title)}</title>
</head>
<body${bodyClass}>
<div id="root" role="main"></div>
<script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>`;
}
