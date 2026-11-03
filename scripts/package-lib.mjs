// Pure helpers for scripts/package.mjs and scripts/smoke.mjs: VSIX names, the size gate and its report,
// and a zip reader that keeps file modes (the bundled interpreter must stay executable).
import { inflateRawSync } from "node:zlib";

export class PackageError extends Error {}

export const OUT_DIR = "dist-vsix";

/** `opentide-<target>-<version>.vsix`, or `opentide-universal-<version>.vsix`. */
export function vsixName(target, version) {
  return `opentide-${target ?? "universal"}-${version}.vsix`;
}

/**
 * Pre-releases use odd minor versions (SPEC §3): such a version is always packaged with `--pre-release`,
 * which `vsce publish --pre-release` requires.
 */
export function isPreReleaseVersion(version) {
  const match = /^\d+\.(\d+)\./.exec(version);
  return match?.[1] !== undefined && Number(match[1]) % 2 === 1;
}

/**
 * The .vscodeignore for the universal package: the same, with the runtime excluded even when a build
 * left one in runtime/.
 */
export function universalIgnore(text) {
  const lines = text.split(/\r?\n/).filter((line) => !/^!\s*runtime(?:\/|$)/.test(line.trim()));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return `${[...lines, "runtime/**"].join("\n")}\n`;
}

/**
 * The size gate. `vsix.budgetBytes` (SPEC §3: 100 MB), unless `vsix.budgetOverrideBytes` names the
 * pinned opentide version: an explicit, temporary allowance with its reason, dropped by the next bump.
 */
export function budgetFor(pins) {
  const base = pins.vsix?.budgetBytes;
  if (typeof base !== "number") throw new PackageError("pins.json has no vsix.budgetBytes");
  const override = pins.vsix?.budgetOverrideBytes;
  if (override && override.opentide === pins.opentide.version && typeof override.bytes === "number") {
    return { bytes: override.bytes, budgetBytes: base, override };
  }
  return { bytes: base, budgetBytes: base, ...(override ? { staleOverride: override } : {}) };
}

/** Read a zip's central directory: [{ name, method, compressedSize, size, mode, offset }]. */
export function zipEntries(buffer) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PackageError("not a zip archive (no end of central directory)");
  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    // Zip64: the locator sits just before the end record.
    const locator = eocd - 20;
    if (locator < 0 || buffer.readUInt32LE(locator) !== 0x07064b50)
      throw new PackageError("corrupt zip64 archive");
    const record = Number(buffer.readBigUInt64LE(locator + 8));
    count = Number(buffer.readBigUInt64LE(record + 32));
    offset = Number(buffer.readBigUInt64LE(record + 48));
  }
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new PackageError("corrupt zip central directory");
    const madeBy = buffer.readUInt16LE(offset + 4) >> 8;
    const method = buffer.readUInt16LE(offset + 10);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const external = buffer.readUInt32LE(offset + 38);
    let localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    // Zip64 extra field: sizes and offset that did not fit.
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = buffer.readUInt16LE(extra);
      const length = buffer.readUInt16LE(extra + 2);
      if (id === 0x0001) {
        let at = extra + 4;
        if (size === 0xffffffff) {
          size = Number(buffer.readBigUInt64LE(at));
          at += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(buffer.readBigUInt64LE(at));
          at += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(buffer.readBigUInt64LE(at));
      }
      extra += 4 + length;
    }
    offset = extraEnd + commentLength;
    if (name.endsWith("/")) continue;
    if (name.split("/").includes("..") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
      throw new PackageError(`unsafe path in zip: ${name}`);
    }
    const mode = madeBy === 3 ? (external >>> 16) & 0o7777 : 0;
    entries.push({ name, method, compressedSize, size, mode, offset: localOffset });
  }
  return entries;
}

/** The bytes of one entry. */
export function zipRead(buffer, entry) {
  const nameLength = buffer.readUInt16LE(entry.offset + 26);
  const extraLength = buffer.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new PackageError(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/**
 * The folder a file's bytes are counted under: a site-packages distribution
 * (`…/site-packages/<package>`), else its directory, at most three levels below `extension/`.
 */
export function sizeUnit(name) {
  const parts = name.split("/");
  const site = parts.indexOf("site-packages");
  if (site >= 0 && site + 1 < parts.length - 1) return parts.slice(0, site + 2).join("/");
  const dirs = parts.slice(0, -1);
  return dirs.length === 0 ? "(root)" : dirs.slice(0, 4).join("/");
}

/** The `count` largest folders by compressed bytes: [{ path, bytes, size, files }]. */
export function largestDirectories(entries, count = 5) {
  const units = new Map();
  for (const entry of entries) {
    const key = sizeUnit(entry.name);
    const unit = units.get(key) ?? { path: key, bytes: 0, size: 0, files: 0 };
    unit.bytes += entry.compressedSize;
    unit.size += entry.size;
    unit.files += 1;
    units.set(key, unit);
  }
  return [...units.values()].sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : 1)).slice(0, count);
}

export function mib(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

/** The size report written next to each VSIX (`<name>.size.json`) for the CI summary. */
export function sizeReport({ file, target, bytes, entries, budget, targetBytes, opentide }) {
  return {
    file,
    target: target ?? "universal",
    opentide,
    bytes,
    files: entries.length,
    installedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    budgetBytes: budget.bytes,
    ...(budget.override ? { budgetOverride: budget.override } : {}),
    targetBytes,
    withinBudget: bytes <= budget.bytes,
    withinTarget: typeof targetBytes === "number" ? bytes <= targetBytes : undefined,
    largest: largestDirectories(entries, 5),
  };
}

/** The lines printed for a report (and on failure). */
export function formatReport(report) {
  const lines = [
    `${report.file}: ${mib(report.bytes)} (${report.bytes} bytes, ${report.files} files, ${mib(report.installedBytes)} installed)`,
    `budget ${mib(report.budgetBytes)}${report.budgetOverride ? ` (override for opentide ${report.budgetOverride.opentide}: ${report.budgetOverride.reason})` : ""}` +
      (typeof report.targetBytes === "number" ? `, target ${mib(report.targetBytes)}` : ""),
    "largest directories (compressed / installed):",
    ...report.largest.map(
      (unit) =>
        `  ${mib(unit.bytes).padStart(10)} / ${mib(unit.size).padStart(10)}  ${unit.path} (${unit.files} files)`,
    ),
  ];
  return lines;
}
