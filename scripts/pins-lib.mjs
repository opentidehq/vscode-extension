// Pure helpers for scripts/pins.mjs: pins.json's engine assets from an opentide release's SHA256SUMS, and
// @opentide/opentide's npm integrity from the registry's documents.
//
// Since the unified core (opentidehq/opentide#790), opentide's own release publishes the engine assets
// language-server used to: highlights-v<version>.zip, opentide-wasm-web-v<version>.zip and
// THIRD-PARTY-LICENSES.html, with SHA256SUMS. The assets carry the release's version (`v0.24.0`); the
// engine reports its crate's (`0.12.0`), which pins.json `engine.version` holds, since dist/engine/engine.json
// and the smoke test compare it with what the engine answers.
import { PACKAGE, TARGETS } from "./opentide-lib.mjs";

export class PinsError extends Error {}

export const OPENTIDE_REPOSITORY = "opentidehq/opentide";

/** `<sha256>  <name>` lines (sha256sum's text or binary mode) as a Map of name to digest. */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2].replace(/^\.\//, ""), match[1]);
  }
  return sums;
}

/** A release's download URL for one asset. */
export function assetUrl(release, name, repository = OPENTIDE_REPOSITORY) {
  return `https://github.com/${repository}/releases/download/v${release}/${name}`;
}

/**
 * pins.json's `highlights` and `engine` for opentide release `release` (`0.24.0`), from its SHA256SUMS.
 * `engineVersion` is the version the engine reports (its crate's). Every asset must be in the sums.
 */
export function enginePins(release, engineVersion, sumsText, repository = OPENTIDE_REPOSITORY) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(release))
    throw new PinsError(`not a release version: ${release}`);
  if (!/^\d+\.\d+\.\d+/.test(engineVersion ?? ""))
    throw new PinsError(`not an engine version: ${engineVersion}`);
  const sums = parseSha256Sums(sumsText);
  const digest = (name) => {
    const sha256 = sums.get(name);
    if (!sha256) throw new PinsError(`SHA256SUMS of v${release} has no ${name}`);
    return sha256;
  };
  const highlights = `highlights-v${release}.zip`;
  const wasm = `opentide-wasm-web-v${release}.zip`;
  const licenses = "THIRD-PARTY-LICENSES.html";
  return {
    highlights: {
      version: release,
      url: assetUrl(release, highlights, repository),
      sha256: digest(highlights),
    },
    engine: {
      version: engineVersion,
      release,
      url: assetUrl(release, wasm, repository),
      sha256: digest(wasm),
      thirdPartyLicenses: { url: assetUrl(release, licenses, repository), sha256: digest(licenses) },
    },
  };
}

/** The packages a platform VSIX may take from npm: the package and its six native packages. */
export function npmPackages() {
  return [PACKAGE, ...Object.values(TARGETS).map((platform) => `${PACKAGE}-${platform}`)];
}

/** The registry's document URL for one version of a package. */
export function registryUrl(name, version) {
  return `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;
}

/** `dist.integrity` of a registry version document; it must be sha512. */
export function integrityFrom(document, name, version) {
  if (document?.name !== name || document?.version !== version)
    throw new PinsError(
      `the registry answered ${document?.name}@${document?.version} for ${name}@${version}`,
    );
  const integrity = document.dist?.integrity;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-"))
    throw new PinsError(`${name}@${version} has no sha512 integrity`);
  return integrity;
}

/**
 * pins.json with `opentide` at `version` and its npm integrity, and the engine assets of the same release
 * when given: the source build (`opentide.source`) is dropped, since the registry has the package.
 */
export function updatedPins(pins, { version, integrity, engine }) {
  const { source: _source, ...opentide } = pins.opentide;
  const next = {
    ...pins,
    opentide: { ...opentide, version, npm: { ...opentide.npm, integrity } },
  };
  if (engine) {
    next.highlights = { ...pins.highlights, ...engine.highlights };
    next.engine = { ...pins.engine, ...engine.engine };
  }
  return next;
}
