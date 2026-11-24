// Pure helpers for scripts/av-gate.mjs, the antivirus gate every store package passes before a release
// (.github/workflows/av-gate.yml, docs/RELEASING.md "The antivirus gate"). The Marketplace banned the old
// publisher for bundling heavy native binaries and for Defender detections: the package carries WebAssembly,
// JavaScript and data, and no native executable at any depth, nested archives included. No IO here.
import { gunzipSync } from "node:zlib";

import { PackageError, zipEntries, zipRead } from "./package-lib.mjs";

/** How deep archives inside archives are opened; deeper is refused rather than left unread. */
const MAX_DEPTH = 8;

/** The native executable format `bytes` starts with, or undefined. */
export function nativeFormat(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)
    return "ELF";
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    // MZ, and the PE header its e_lfanew points to.
    const pe = bytes.readUInt32LE(0x3c);
    if (pe + 4 <= bytes.length && bytes.readUInt32BE(pe) === 0x50450000) return "PE";
  }
  if (bytes.length >= 8) {
    const magic = bytes.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return "Mach-O";
    // A universal (fat) Mach-O; a Java class file shares the magic, with its version (>= 45) where the
    // fat header has its architecture count (a handful).
    if (
      (magic === 0xcafebabe || magic === 0xcafebabf) &&
      bytes.readUInt32BE(4) > 0 &&
      bytes.readUInt32BE(4) < 20
    )
      return "Mach-O (universal)";
    if (magic === 0xbebafeca && bytes.readUInt32LE(4) > 0 && bytes.readUInt32LE(4) < 20)
      return "Mach-O (universal)";
  }
  return undefined;
}

const isZip = (bytes) => bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
const isGzip = (bytes) => bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
const isTar = (bytes) => bytes.length >= 512 && bytes.toString("latin1", 257, 262) === "ustar";

/** A tar's regular files: `[{ name, bytes }]`. */
function tarFiles(bytes) {
  const files = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.toString("latin1", start, start + length).replace(/\0.*$/s, "");
    const name = `${field(345, 155) ? `${field(345, 155)}/` : ""}${field(0, 100)}`;
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const start = offset + 512;
    if (type === "0" || type === "") files.push({ name, bytes: bytes.subarray(start, start + size) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Every native executable in `bytes` (a file, or an archive opened recursively: zip, VSIX, gzip, tar), as
 * `{ path, format }`, where `path` joins the archive members with `!/`. An archive that cannot be read, or
 * nested deeper than MAX_DEPTH, is a problem too: what is not read is not passed.
 */
export function nativeExecutables(bytes, path, depth = 0) {
  const format = nativeFormat(bytes);
  if (format) return [{ path, format }];
  if (!isZip(bytes) && !isGzip(bytes) && !isTar(bytes)) return [];
  if (depth >= MAX_DEPTH) return [{ path, format: `an archive nested deeper than ${MAX_DEPTH} levels` }];
  try {
    if (isGzip(bytes)) return nativeExecutables(gunzipSync(bytes), `${path}!/(gunzip)`, depth + 1);
    if (isTar(bytes))
      return tarFiles(bytes).flatMap((file) =>
        nativeExecutables(file.bytes, `${path}!/${file.name}`, depth + 1),
      );
    return zipEntries(bytes).flatMap((entry) =>
      nativeExecutables(zipRead(bytes, entry), `${path}!/${entry.name}`, depth + 1),
    );
  } catch (error) {
    if (error instanceof PackageError || error instanceof RangeError || error?.code?.startsWith?.("Z_"))
      return [{ path, format: `an archive that cannot be read (${error.message})` }];
    throw error;
  }
}

/**
 * Whether a package grew past the size it was recorded at: `pins.json` `vsix.recordedBytes`, plus
 * `vsix.growthLimit` (a fraction, 0.1 for 10 %). A growth that is meant goes with a new record in the same PR.
 */
export function sizeGrowthProblem(name, bytes, vsix) {
  const recorded = vsix?.recordedBytes;
  const limit = vsix?.growthLimit;
  if (typeof recorded !== "number" || typeof limit !== "number")
    return "pins.json has no vsix.recordedBytes and vsix.growthLimit";
  const allowed = Math.floor(recorded * (1 + limit));
  if (bytes <= allowed) return undefined;
  const grown = (((bytes - recorded) / recorded) * 100).toFixed(1);
  return (
    `${name} is ${bytes} bytes, ${grown} % over the ${recorded} recorded in pins.json vsix.recordedBytes ` +
    `(limit ${Math.round(limit * 100)} %): find what grew, or record the new size in the same PR`
  );
}
