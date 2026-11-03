// Pure helpers for scripts/grammars.mjs: zip reading, checksum, grammar transforms.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

export class GrammarError extends Error {}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function verifySha256(buffer, expected, what) {
  const actual = sha256(buffer);
  if (typeof expected !== "string" || actual !== expected.toLowerCase()) {
    throw new GrammarError(`${what}: SHA-256 is ${actual}, but pins.json records ${expected}`);
  }
}

/** Read every file of a zip archive (stored or deflated entries) into a Map of name -> Buffer. */
export function readZip(buffer) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new GrammarError("not a zip archive (no end of central directory)");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new GrammarError("corrupt zip central directory");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (name.includes("..") || name.startsWith("/")) throw new GrammarError(`unsafe path in zip: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new GrammarError(`unsupported zip compression method ${method} for ${name}`);
  }
  return files;
}

/** The scopes this extension owns. ES|QL is renamed off Elastic's scope (language-server#195). */
export const ESQL_FROM = "source.esql";
export const ESQL_TO = "source.opentide.esql";
export const TOML_FROM = "source.toml";
export const TOML_TO = "source.opentide.toml";

const GRAMMAR_FILE = /^generated\/([a-z-]+)\.tmLanguage\.json$/;

/** The language id each zip grammar serves: the file stem, except `tide`. */
export function languageFor(stem) {
  return stem === "tide" ? "opentide-yaml" : stem;
}

/**
 * Turn the highlights zip into the grammar files to write and the `contributes.grammars` fragment.
 * Fails when the ES|QL grammar still refers to `source.esql` after the scope rename.
 */
export function transformHighlights(files) {
  const contributionsRaw = files.get("generated/package-contributions.json");
  if (!contributionsRaw) throw new GrammarError("zip has no generated/package-contributions.json");
  const contributions = JSON.parse(contributionsRaw.toString("utf8"));
  const embedded = new Map();
  for (const grammar of contributions.contributes?.grammars ?? []) {
    if (grammar.embeddedLanguages) embedded.set(grammar.scopeName, grammar.embeddedLanguages);
  }

  const outputs = new Map();
  const grammars = [];
  for (const [name, raw] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const match = GRAMMAR_FILE.exec(name);
    if (!match) continue;
    const stem = match[1];
    const grammar = JSON.parse(raw.toString("utf8"));
    if (stem === "esql" && grammar.scopeName === ESQL_FROM) grammar.scopeName = ESQL_TO;
    const text = `${JSON.stringify(grammar, null, 2)}\n`;
    outputs.set(`${stem}.tmLanguage.json`, text);
    const entry = {
      language: languageFor(stem),
      scopeName: grammar.scopeName,
      path: `./syntaxes/${stem}.tmLanguage.json`,
    };
    const embeddedLanguages = embedded.get(grammar.scopeName);
    if (embeddedLanguages) entry.embeddedLanguages = embeddedLanguages;
    grammars.push(entry);
  }
  if (!outputs.has("esql.tmLanguage.json"))
    throw new GrammarError("zip has no generated/esql.tmLanguage.json");
  for (const [file, text] of outputs) {
    if (text.includes(ESQL_FROM)) {
      throw new GrammarError(`${file} still refers to ${ESQL_FROM}, Elastic's scope; it must be ${ESQL_TO}`);
    }
  }
  return { outputs, grammars };
}

/** Rename the copied TOML grammar's scope and fail when the old scope remains. */
export function transformToml(raw) {
  const grammar = JSON.parse(raw.toString("utf8"));
  if (grammar.scopeName !== TOML_FROM && grammar.scopeName !== TOML_TO) {
    throw new GrammarError(`TOML grammar has scope ${grammar.scopeName}, expected ${TOML_FROM}`);
  }
  grammar.scopeName = TOML_TO;
  const text = `${JSON.stringify(grammar, null, 2)}\n`;
  if (text.includes(TOML_FROM)) {
    throw new GrammarError(`TOML grammar still refers to ${TOML_FROM}`);
  }
  return {
    text,
    entry: {
      language: "opentide-config",
      scopeName: TOML_TO,
      path: "./syntaxes/opentide-config.tmLanguage.json",
    },
  };
}
