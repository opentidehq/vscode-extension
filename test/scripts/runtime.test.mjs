import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  archiveName,
  archiveUrl,
  buildId,
  buildInfo,
  checkNativeLicenses,
  cyclonedx,
  downloadEntry,
  expectedArchiveSha,
  fullArchive,
  hostTarget,
  installArgs,
  installedTags,
  isStaticInterpreter,
  lf,
  licenseFiles,
  licenseOf,
  lockArgs,
  nativeComponents,
  nativeLicensesPath,
  nativeSections,
  needsSourceOffer,
  noWheelsError,
  packagesWithoutWheels,
  parseLock,
  parseMetadata,
  parseSha256Sums,
  pbsDownloadsUrl,
  pickWheel,
  RuntimeError,
  recordArchiveSha,
  requirementsIn,
  requireRuntimeTarget,
  runtimeNotices,
  runtimeTargets,
  serialNumber,
  shouldRemove,
  TARGETS,
  tarCommand,
  uvVersion,
  wheelTags,
} from "../../scripts/runtime-lib.mjs";
import { TarReader } from "../../scripts/tar-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pinsText = readFileSync(join(root, "pins.json"), "utf8");
const pins = JSON.parse(pinsText);
const testPins = {
  opentide: { version: "0.21.0" },
  highlights: { version: "0.9.1" },
  python: {
    pythonBuildStandalone: "20260718",
    cpython: "3.13.14",
    flavor: "install_only_stripped",
    macosDeploymentTarget: "11.0",
  },
  runtimeTargets: ["linux-x64", "win32-x64"],
  universalTargets: { "win32-arm64": "no win_arm64 wheel" },
  runtimeArchives: { "linux-x64": { sha256: null } },
};

describe("runtime build: targets and pins", () => {
  it("knows the eight VS Code targets with their python-build-standalone and uv triples", () => {
    assert.deepEqual(Object.keys(TARGETS).sort(), [
      "alpine-arm64",
      "alpine-x64",
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    assert.equal(TARGETS["alpine-x64"].uv, "x86_64-unknown-linux-musl");
    assert.equal(TARGETS["linux-arm64"].uv, "aarch64-manylinux_2_28");
    assert.equal(hostTarget("linux", "x64"), "linux-x64");
    assert.equal(hostTarget("linux", "arm64", true), "alpine-arm64");
    assert.equal(hostTarget("win32", "ia32"), undefined);
  });

  it("the committed pins: runtimeTargets are known targets, the others say why they are universal", () => {
    const targets = runtimeTargets(pins);
    for (const name of Object.keys(TARGETS)) {
      if (!targets.includes(name))
        assert.ok(pins.universalTargets?.[name], `${name} needs a universalTargets reason`);
    }
    assert.throws(() => requireRuntimeTarget(pins, "win32-arm64"), /universal package.*win_arm64/);
  });

  it("an empty runtimeTargets means universal only", () => {
    const universal = { ...testPins, runtimeTargets: [] };
    assert.deepEqual(runtimeTargets(universal), []);
    assert.throws(() => requireRuntimeTarget(universal, "linux-x64"), RuntimeError);
    assert.throws(() => runtimeTargets({ ...testPins, runtimeTargets: ["linux-armhf"] }), /unknown target/);
  });

  it("names the python-build-standalone archive and its GitHub release URL", () => {
    assert.equal(
      archiveName(testPins, "darwin-arm64"),
      "cpython-3.13.14+20260718-aarch64-apple-darwin-install_only_stripped.tar.gz",
    );
    assert.equal(
      archiveUrl(testPins, "linux-x64"),
      "https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.13.14%2B20260718-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
    );
  });

  it("checks the archive against SHA256SUMS until pins.json records it, then against pins.json", () => {
    const name = archiveName(testPins, "linux-x64");
    const sums = parseSha256Sums(`${"a".repeat(64)}  ${name}\n${"b".repeat(64)}  other.tar.gz\n`);
    assert.deepEqual(expectedArchiveSha(testPins, "linux-x64", sums), {
      sha256: "a".repeat(64),
      record: true,
      archive: name,
    });
    assert.equal(
      expectedArchiveSha(testPins, "linux-x64"),
      undefined,
      "nothing recorded and no SHA256SUMS yet",
    );
    assert.throws(() => expectedArchiveSha(testPins, "darwin-x64", sums), /has no cpython/);

    const recorded = {
      ...testPins,
      runtimeArchives: { "linux-x64": { archive: name, sha256: "C".repeat(64) } },
    };
    assert.deepEqual(expectedArchiveSha(recorded, "linux-x64", sums), {
      sha256: "c".repeat(64),
      record: false,
      archive: name,
    });
    const bumped = { ...recorded, python: { ...testPins.python, pythonBuildStandalone: "20270101" } };
    assert.throws(() => expectedArchiveSha(bumped, "linux-x64", sums), /set its archive and sha256 to null/);
  });

  it("the committed pins record every archive for the pinned python-build-standalone", () => {
    for (const name of Object.keys(TARGETS)) {
      const expected = expectedArchiveSha(pins, name);
      assert.match(expected?.sha256 ?? "", /^[0-9a-f]{64}$/, name);
    }
  });

  it("records an archive's SHA-256 in pins.json without touching the rest", () => {
    const text =
      '{\n  "a": 1,\n  "runtimeArchives": {\n    "linux-x64": { "sha256": null },\n    "linux-arm64": { "sha256": null }\n  }\n}\n';
    const out = recordArchiveSha(text, "linux-x64", "x.tar.gz", "f".repeat(64));
    assert.equal(
      out,
      `{\n  "a": 1,\n  "runtimeArchives": {\n    "linux-x64": {\n      "archive": "x.tar.gz",\n      "sha256": "${"f".repeat(64)}"\n    },\n    "linux-arm64": { "sha256": null }\n  }\n}\n`,
    );
    assert.deepEqual(JSON.parse(recordArchiveSha('{"x":1}', "linux-x64", "y", "0")).runtimeArchives, {
      "linux-x64": { archive: "y", sha256: "0" },
    });
  });
});

describe("runtime build: locks", () => {
  it("requirements.in pins the bundled opentide, and the committed one matches pins.json", () => {
    assert.match(requirementsIn(testPins), /^opentide==0\.21\.0$/m);
    assert.equal(readFileSync(join(root, "runtime", "requirements.in"), "utf8"), requirementsIn(pins));
  });

  it("locks wheels only, hashed, for the target's platform and CPython", () => {
    const args = lockArgs(testPins, "alpine-arm64", "out.txt");
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(value("--python-platform"), "aarch64-unknown-linux-musl");
    assert.equal(value("--python-version"), "3.13.14");
    assert.equal(value("--only-binary"), ":all:");
    assert.ok(args.includes("--generate-hashes"));
    assert.equal(value("-o"), "out.txt");
  });

  it("installs for another platform with --require-hashes and no sdists", () => {
    const args = installArgs(testPins, "win32-x64", "lock.txt", "rt/Lib/site-packages");
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(value("--target"), "rt/Lib/site-packages");
    assert.equal(value("--python-platform"), "x86_64-pc-windows-msvc");
    assert.ok(args.includes("--require-hashes"));
    assert.equal(value("--only-binary"), ":all:");
    assert.ok(!args.includes("--python"));
    assert.equal(installArgs(testPins, "linux-x64", "l", "s", "/py").at(-3), "/py");
  });

  it("names the packages without wheels and fails clearly", () => {
    const stderr =
      "  × No solution found when resolving dependencies:\n  ╰─▶ Because opentide==0.21.0 has no usable wheels and you require\n      opentide==0.21.0, we can conclude that your requirements are\n      unsatisfiable.\n\nhint: Wheels are required for `opentide` because building from source is disabled";
    assert.deepEqual(packagesWithoutWheels(stderr), ["opentide"]);
    const error = noWheelsError("win32-arm64", stderr);
    assert.ok(error instanceof RuntimeError);
    assert.match(error.message, /win32-arm64: opentide has no wheel for aarch64-pc-windows-msvc/);
    assert.match(error.message, /universal package/);
    assert.equal(noWheelsError("linux-x64", "error: network unreachable"), undefined);
  });

  it("parses a hashed lock and refuses an unhashed entry", () => {
    const lock = parseLock(
      "# header\nPyYAML==6.0.3 \\\n    --hash=sha256:" +
        "1".repeat(64) +
        " \\\n    --hash=sha256:" +
        "2".repeat(64) +
        "\n    # via opentide\nruamel.yaml==0.19.1 ; python_version >= '3.10' \\\n    --hash=sha256:" +
        "3".repeat(64) +
        "\n",
    );
    assert.deepEqual(lock, [
      { name: "pyyaml", version: "6.0.3", hashes: ["1".repeat(64), "2".repeat(64)] },
      { name: "ruamel-yaml", version: "0.19.1", hashes: ["3".repeat(64)] },
    ]);
    assert.throws(() => parseLock("six==1.17.0\n"), /has no hash/);
  });

  it("every committed lock is hashed, pins the bundled opentide, and exists for each runtime target", () => {
    for (const name of runtimeTargets(pins)) {
      const lock = parseLock(readFileSync(join(root, "runtime", "locks", `${name}.txt`), "utf8"));
      assert.equal(lock.find((pkg) => pkg.name === "opentide")?.version, pins.opentide.version, name);
    }
  });
});

describe("runtime build: trimming the interpreter", () => {
  const posix = { name: "linux-x64", cpython: "3.13.14", staticInterpreter: true };
  const win = { name: "win32-x64", cpython: "3.13.14", staticInterpreter: false };

  it("removes what SPEC §3 lists on POSIX", () => {
    for (const rel of [
      "include",
      "share",
      "lib/libpython3.13.so",
      "lib/libpython3.13.so.1.0",
      "lib/libpython3.so",
      "lib/libpython3.13.dylib",
      "lib/libtcl9.0.so",
      "lib/libtcl9tk9.0.so",
      "lib/tcl9.0",
      "lib/tk9.0",
      "lib/itcl4.3.5",
      "lib/pkgconfig",
      "lib/python3.13/tkinter",
      "lib/python3.13/idlelib",
      "lib/python3.13/ensurepip",
      "lib/python3.13/turtledemo",
      "lib/python3.13/test",
      "lib/python3.13/config-3.13-x86_64-linux-gnu",
      "lib/python3.13/lib-dynload/_tkinter.cpython-313-x86_64-linux-gnu.so",
      "lib/python3.13/lib-dynload/_testcapi.cpython-313-x86_64-linux-gnu.so",
      "lib/python3.13/json/__pycache__",
      "lib/python3.13/site-packages/pip",
      "lib/python3.13/site-packages/pip-25.1.dist-info",
      "lib/python3.13/site-packages/pandas/tests",
      "lib/python3.13/site-packages/numpy/linalg/tests",
      "bin/pip3.13",
      "bin/idle3",
      "bin/pydoc3.13",
      "bin/python3.13-config",
    ]) {
      assert.ok(shouldRemove(rel, posix), rel);
    }
  });

  it("keeps what opentide loads", () => {
    for (const rel of [
      "bin/python3",
      "lib/python3.13",
      "lib/python3.13/json/decoder.py",
      "lib/python3.13/unittest/mock.py",
      "lib/python3.13/lib-dynload/_ssl.cpython-313-x86_64-linux-gnu.so",
      "lib/python3.13/site-packages/opentide/_native.abi3.so",
      "lib/python3.13/site-packages/numpy/testing",
      "lib/python3.13/site-packages/tests",
      "lib/python3.13/site-packages/pipx",
      "lib/python3.13/LICENSE.txt",
    ]) {
      assert.ok(!shouldRemove(rel, posix), rel);
    }
    assert.ok(!shouldRemove("lib/libpython3.13.so.1.0", { ...posix, staticInterpreter: false }));
  });

  it("removes what SPEC §3 lists on Windows and keeps python313.dll", () => {
    for (const rel of [
      "include",
      "libs",
      "tcl",
      "Scripts",
      "DLLs/_tkinter.pyd",
      "DLLs/tcl86t.dll",
      "DLLs/tk86t.dll",
      "DLLs/_testcapi.pyd",
      "DLLs/_ctypes_test.pyd",
      "Lib/idlelib",
      "Lib/test",
      "Lib/site-packages/pip",
    ]) {
      assert.ok(shouldRemove(rel, win), rel);
    }
    for (const rel of [
      "python.exe",
      "python313.dll",
      "python3.dll",
      "DLLs/_ssl.pyd",
      "DLLs/libssl-3-x64.dll",
      "Lib/site-packages/opentide",
    ]) {
      assert.ok(!shouldRemove(rel, win), rel);
    }
  });

  it("tells a static interpreter from one that loads libpython", () => {
    assert.equal(isStaticInterpreter("linux-x64", "3.13.14", Buffer.from("\x7fELF...libc.so.6")), true);
    assert.equal(
      isStaticInterpreter("linux-x64", "3.13.14", Buffer.from("\x7fELF libpython3.13.so.1.0")),
      false,
    );
    assert.equal(
      isStaticInterpreter("darwin-arm64", "3.13.14", Buffer.from("@rpath/libpython3.13.dylib")),
      false,
    );
    assert.equal(isStaticInterpreter("win32-x64", "3.13.14", Buffer.from("")), false);
  });
});

describe("runtime build: metadata, SBOM and notices", () => {
  const metadata = (text) => parseMetadata(text);

  it("parses core metadata with repeated and folded fields", () => {
    const meta = metadata(
      "Metadata-Version: 2.4\nName: opentide\nVersion: 0.21.0\nLicense-Expression: EUPL-1.2\nLicense-File: LICENSE\nLicense-File: NOTICE\nDescription: one\n        two\n\nbody: not a header\n",
    );
    assert.deepEqual(meta.get("license-file"), ["LICENSE", "NOTICE"]);
    assert.equal(meta.get("description")?.[0], "one\ntwo");
    assert.equal(meta.get("body"), undefined);
  });

  it("finds the licence: expression, short field, classifiers, else the text", () => {
    assert.deepEqual(licenseOf(metadata("License-Expression: EUPL-1.2\n")), { expression: "EUPL-1.2" });
    assert.deepEqual(licenseOf(metadata("License: Apache 2.0\n")), { id: "Apache-2.0" });
    assert.deepEqual(licenseOf(metadata("Classifier: License :: OSI Approved :: MIT License\n")), {
      id: "MIT",
    });
    assert.deepEqual(
      licenseOf(
        metadata(
          "Classifier: License :: OSI Approved :: MIT License\nClassifier: License :: OSI Approved :: Apache Software License\n",
        ),
      ),
      { expression: "Apache-2.0 OR MIT" },
    );
    assert.deepEqual(licenseOf(metadata("License: Dual License\n")), { name: "Dual License" });
    assert.deepEqual(licenseOf(metadata("Classifier: License :: OSI Approved :: BSD License\n")), {
      name: "BSD License",
    });
  });

  it("finds the licence files of a dist-info, PEP 639 or not", () => {
    assert.deepEqual(
      licenseFiles(metadata("License-File: LICENSE\nLicense-File: vendor/NOTICE\n"), [
        "licenses/LICENSE",
        "licenses/vendor/NOTICE",
        "METADATA",
      ]),
      ["licenses/LICENSE", "licenses/vendor/NOTICE"],
    );
    assert.deepEqual(licenseFiles(metadata("License-File: LICENSE.txt\n"), ["LICENSE.txt", "RECORD"]), [
      "LICENSE.txt",
    ]);
    assert.deepEqual(licenseFiles(metadata(""), ["AUTHORS.rst", "COPYING", "RECORD", "WHEEL"]), [
      "AUTHORS.rst",
      "COPYING",
    ]);
  });

  it("identifies the installed wheel by its tags and the lock's hashes", () => {
    assert.deepEqual(
      [
        ...wheelTags("pydantic_core-2.50.2-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"),
      ].sort(),
      ["cp313-cp313-manylinux2014_x86_64", "cp313-cp313-manylinux_2_17_x86_64"],
    );
    const tags = installedTags(
      "Wheel-Version: 1.0\nTag: cp313-cp313-manylinux_2_17_x86_64\nTag: cp313-cp313-manylinux2014_x86_64\n",
    );
    const files = [
      {
        filename: "p-1-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
        digests: { sha256: "a" },
        url: "u1",
      },
      { filename: "p-1-cp313-cp313-musllinux_1_2_x86_64.whl", digests: { sha256: "b" }, url: "u2" },
      { filename: "p-1.tar.gz", digests: { sha256: "c" }, url: "u3" },
    ];
    assert.equal(pickWheel(files, tags, ["a", "b", "c"])?.url, "u1");
    assert.equal(pickWheel(files, tags, ["b"]), undefined, "a wheel the lock does not hash is not it");
  });

  it("writes BUILD-INFO with a stable build id", () => {
    const info = buildInfo({
      pins: testPins,
      name: "linux-x64",
      archiveSha256: "a",
      lockSha256: "b",
      staticInterpreter: true,
    });
    assert.equal(
      info.buildId,
      buildId({ target: "linux-x64", archiveSha256: "a", lockSha256: "b", opentide: "0.21.0" }),
    );
    assert.notEqual(
      info.buildId,
      buildId({ target: "linux-x64", archiveSha256: "a", lockSha256: "c", opentide: "0.21.0" }),
    );
    assert.equal(info.python, "bin/python3");
    assert.equal(info.engine, "0.9.1");
    assert.equal(
      buildInfo({ pins: testPins, name: "win32-x64", archiveSha256: "a", lockSha256: "b" }).python,
      "python.exe",
    );
  });

  it("writes a CycloneDX 1.5 SBOM of the interpreter and the closure", () => {
    const info = buildInfo({
      pins: testPins,
      name: "linux-x64",
      archiveSha256: "f".repeat(64),
      lockSha256: "e",
      staticInterpreter: true,
    });
    const sbom = cyclonedx({
      info,
      extensionVersion: "0.2.0",
      dists: [
        {
          name: "pyyaml",
          version: "6.0.3",
          license: { id: "MIT" },
          wheel: { filename: "x.whl", sha256: "1".repeat(64), url: "https://files/x.whl" },
        },
        {
          name: "opentide",
          version: "0.21.0",
          license: { expression: "EUPL-1.2" },
          wheel: { filename: "o.whl", sha256: "2".repeat(64), url: "https://files/o.whl" },
        },
      ],
    });
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.specVersion, "1.5");
    assert.match(
      sbom.serialNumber,
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.deepEqual(
      sbom.components.map((c) => c.name),
      ["cpython", "opentide", "pyyaml"],
    );
    const [cpython, opentide] = sbom.components;
    assert.deepEqual(cpython.licenses, [{ license: { id: "PSF-2.0" } }]);
    assert.deepEqual(cpython.hashes, [{ alg: "SHA-256", content: "f".repeat(64) }]);
    assert.deepEqual(opentide.licenses, [{ expression: "EUPL-1.2" }]);
    assert.equal(opentide.purl, "pkg:pypi/opentide@0.21.0");
    assert.equal(sbom.dependencies[0].dependsOn.length, 3);
    assert.equal(serialNumber("0".repeat(32)), "urn:uuid:00000000-0000-5000-8000-000000000000");
  });

  it("writes notices with each component's licence and files", () => {
    const info = buildInfo({ pins: testPins, name: "linux-x64", archiveSha256: "a", lockSha256: "b" });
    const text = runtimeNotices(info, [
      {
        title: "CPython 3.13.14",
        license: "PSF-2.0",
        texts: [{ file: "LICENSE.txt", text: "PSF LICENSE AGREEMENT\n" }],
      },
      { title: "solrq 1.1.2", license: "BSD", texts: [] },
    ]);
    assert.match(text, /opentide and its analysis engine are EUPL-1.2, CPython is PSF-2.0/);
    assert.match(text, /CPython 3\.13\.14 \(PSF-2\.0\)[\s\S]*PSF LICENSE AGREEMENT/);
    assert.match(text, /solrq 1\.1\.2 \(BSD\)[\s\S]*ships no licence file/);
  });
});

describe("runtime build: the native libraries inside CPython", () => {
  const pythonJson = {
    build_info: {
      extensions: {
        _ssl: [
          {
            variant: "default",
            licenses: ["Apache-2.0", "OpenSSL"],
            license_paths: ["licenses/LICENSE.openssl-3.txt"],
          },
        ],
        _curses: [{ variant: "default", licenses: ["X11"], license_paths: ["licenses/LICENSE.ncurses.txt"] }],
        readline: [
          {
            variant: "default",
            licenses: ["BSD-3-Clause", "X11"],
            license_paths: ["licenses/LICENSE.libedit.txt", "licenses/LICENSE.ncurses.txt"],
          },
        ],
        _sqlite3: [
          {
            variant: "default",
            licenses: [],
            license_public_domain: true,
            license_paths: ["licenses/LICENSE.sqlite.txt"],
          },
        ],
        _tkinter: [{ variant: "default", licenses: ["TCL"], license_paths: ["licenses/LICENSE.tcl.txt"] }],
        math: [{ variant: "default", links: [{ name: "m" }] }],
      },
    },
  };

  it("lists one component per licence file, with the modules linking it and the licences they share", () => {
    const components = nativeComponents(pythonJson);
    assert.deepEqual(
      components.map((c) => [c.name, c.modules, c.licenses]),
      [
        ["libedit", ["readline"], ["BSD-3-Clause", "X11"]],
        ["ncurses", ["_curses", "readline"], ["X11"]],
        ["openssl-3", ["_ssl"], ["Apache-2.0", "OpenSSL"]],
        ["sqlite", ["_sqlite3"], ["LicenseRef-Public-Domain"]],
      ],
      "Tk is removed by the build, so Tcl's licence is not listed",
    );
  });

  it("finds the release's full archive, optimised and not free-threaded", () => {
    const sums = new Map([
      ["cpython-3.13.14+20260718-x86_64-unknown-linux-gnu-debug-full.tar.zst", "a".repeat(64)],
      ["cpython-3.13.14+20260718-x86_64-unknown-linux-gnu-freethreaded+pgo+lto-full.tar.zst", "b".repeat(64)],
      ["cpython-3.13.14+20260718-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst", "c".repeat(64)],
      ["cpython-3.13.14+20260718-x86_64-pc-windows-msvc-pgo-full.tar.zst", "d".repeat(64)],
    ]);
    assert.equal(fullArchive(testPins, "linux-x64", sums).sha256, "c".repeat(64));
    assert.match(fullArchive(testPins, "win32-x64", sums).url, /x86_64-pc-windows-msvc-pgo-full\.tar\.zst$/);
    assert.throws(() => fullArchive(testPins, "darwin-arm64", sums), RuntimeError);
  });

  it("puts them in the notices and nests them under cpython in the SBOM", () => {
    const record = {
      pythonBuildStandalone: "20260718",
      cpython: "3.13.14",
      components: nativeComponents(pythonJson),
      texts: {
        "LICENSE.openssl-3.txt": "Apache License 2.0",
        "LICENSE.ncurses.txt": "ncurses",
        "LICENSE.libedit.txt": "libedit",
        "LICENSE.sqlite.txt": null,
      },
    };
    assert.equal(checkNativeLicenses(testPins, "linux-x64", record), record);
    const info = buildInfo({ pins: testPins, name: "linux-x64", archiveSha256: "a", lockSha256: "b" });
    const notices = runtimeNotices(info, nativeSections(record));
    assert.match(
      notices,
      /openssl-3, linked into CPython \(_ssl\) \(Apache-2\.0 AND OpenSSL\)[\s\S]*Apache License 2\.0/,
    );
    assert.match(notices, /sqlite, linked into CPython[\s\S]*ships no licence file/);
    const sbom = cyclonedx({ info, dists: [], extensionVersion: "0.2.0", native: record.components });
    const [cpython] = sbom.components;
    assert.deepEqual(
      cpython.components.map((c) => [c.name, c.licenses]),
      [
        ["libedit", [{ license: { id: "BSD-3-Clause" } }, { license: { id: "X11" } }]],
        ["ncurses", [{ license: { id: "X11" } }]],
        ["openssl-3", [{ license: { id: "Apache-2.0" } }, { license: { id: "OpenSSL" } }]],
        ["sqlite", [{ license: { name: "LicenseRef-Public-Domain" } }]],
      ],
    );
  });

  it("says where Berkeley DB's source is, as its Sleepycat licence asks", () => {
    const downloadsPy = [
      "DOWNLOADS = {",
      '    "bdb": {',
      '        "url": "https://ftp.osuosl.org/pub/blfs/conglomeration/db/db-6.0.19.tar.gz",',
      '        "size": 36541923,',
      '        "sha256": "2917c28f60903908c2ca4587ded1363b812c4e830a5326aaa77c9879d13ae18e",',
      '        "version": "6.0.19",',
      '        "licenses": ["Sleepycat"],',
      "    },",
      '    "binutils": {',
      '        "url": "https://example.invalid/binutils.tar.xz",',
      "    },",
      "}",
    ].join("\n");
    const source = downloadEntry(downloadsPy, "bdb");
    assert.deepEqual(source, {
      version: "6.0.19",
      url: "https://ftp.osuosl.org/pub/blfs/conglomeration/db/db-6.0.19.tar.gz",
      sha256: "2917c28f60903908c2ca4587ded1363b812c4e830a5326aaa77c9879d13ae18e",
    });
    assert.equal(downloadEntry(downloadsPy, "binutils"), undefined, "no version or sha256");
    assert.equal(
      pbsDownloadsUrl("20260718"),
      "https://raw.githubusercontent.com/astral-sh/python-build-standalone/20260718/pythonbuild/downloads.py",
    );
    const bdb = { name: "bdb", file: "LICENSE.bdb.txt", modules: ["_dbm"], licenses: ["Sleepycat"] };
    assert.equal(needsSourceOffer(bdb), true);
    assert.equal(needsSourceOffer({ ...bdb, licenses: ["MIT"] }), false);
    const record = {
      pythonBuildStandalone: "20260718",
      cpython: "3.13.14",
      components: [bdb],
      texts: { "LICENSE.bdb.txt": "Sleepycat" },
    };
    assert.throws(() => checkNativeLicenses(testPins, "linux-x64", record), /no source for bdb/);
    const sourced = { ...record, components: [{ ...bdb, source }] };
    assert.equal(checkNativeLicenses(testPins, "linux-x64", sourced), sourced);
    const info = buildInfo({ pins: testPins, name: "linux-x64", archiveSha256: "a", lockSha256: "b" });
    const notices = runtimeNotices(info, nativeSections(sourced));
    assert.match(
      notices,
      /bdb, linked into CPython \(_dbm\) \(Sleepycat\)\n=+\n\nSource: the complete source of bdb 6\.0\.19/,
    );
    assert.ok(notices.includes(`no charge from ${source.url} (SHA-256 ${source.sha256})`));
    assert.ok(notices.includes("https://github.com/astral-sh/python-build-standalone/tree/20260718"));
    assert.ok(notices.includes("https://www.python.org/ftp/python/3.13.14/Python-3.13.14.tar.xz"));
    const [cpython] = cyclonedx({
      info,
      dists: [],
      extensionVersion: "0.2.0",
      native: sourced.components,
    }).components;
    assert.equal(cpython.components[0].version, "6.0.19");
    assert.deepEqual(cpython.components[0].externalReferences, [
      { type: "source-distribution", url: source.url },
    ]);
  });

  it("refuses licences recorded for another CPython or python-build-standalone, or none", () => {
    const record = { pythonBuildStandalone: "20250101", cpython: "3.13.14", components: [], texts: {} };
    assert.throws(() => checkNativeLicenses(testPins, "linux-x64", record), /npm run runtime:licenses/);
    assert.throws(() => checkNativeLicenses(testPins, "linux-x64", undefined), /is missing/);
  });

  it("every runtime target has its committed native licences, for the pinned CPython", () => {
    for (const name of runtimeTargets(pins)) {
      const file = join(root, nativeLicensesPath(name));
      assert.ok(existsSync(file), `${nativeLicensesPath(name)}: run npm run runtime:licenses`);
      const record = checkNativeLicenses(pins, name, JSON.parse(readFileSync(file, "utf8")));
      assert.ok(
        record.components.some((c) => c.name.startsWith("openssl")),
        `${name} links OpenSSL`,
      );
      // Berkeley DB (Sleepycat) is in the Linux and Alpine interpreters: their notices say where its source is.
      const bdb = record.components.find((c) => c.name === "bdb");
      assert.equal(Boolean(bdb), /^(?:linux|alpine)-/.test(name), `${name} links Berkeley DB`);
      if (bdb) {
        const notices = runtimeNotices(
          buildInfo({ pins, name, archiveSha256: "a", lockSha256: "b" }),
          nativeSections(record),
        );
        assert.match(notices, /Source: the complete source of bdb \d[\d.]+, as linked here, is available/);
        assert.ok(notices.includes(bdb.source.url), name);
      }
    }
  });

  it("reads only the wanted files of a tar stream, long names included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opentide-tar-"));
    try {
      const deep = join("python", "licenses", "x".repeat(120));
      mkdirSync(join(dir, "src", "python", "licenses"), { recursive: true });
      writeFileSync(join(dir, "src", "python", "PYTHON.json"), '{"ok":true}');
      writeFileSync(join(dir, "src", "python", "big.bin"), Buffer.alloc(70_000, 7));
      writeFileSync(join(dir, "src", deep), "long name");
      const tar = spawnSync(tarCommand(process.platform, process.env), [
        "-cf",
        join(dir, "a.tar"),
        "-C",
        join(dir, "src"),
        "python",
      ]);
      assert.equal(tar.status, 0, String(tar.stderr));
      const reader = new TarReader(
        (path) => path === "python/PYTHON.json" || path.startsWith("python/licenses/x"),
      );
      const bytes = readFileSync(join(dir, "a.tar"));
      // Odd chunk sizes, so headers and bodies straddle writes.
      const chunks = [];
      for (let at = 0; at < bytes.length; at += 777) chunks.push(bytes.subarray(at, at + 777));
      await pipeline(Readable.from(chunks), reader);
      assert.deepEqual([...reader.files.keys()].sort(), [
        "python/PYTHON.json",
        `python/licenses/${"x".repeat(120)}`,
      ]);
      assert.equal(reader.files.get("python/PYTHON.json")?.toString(), '{"ok":true}');
      assert.equal(reader.files.get(`python/licenses/${"x".repeat(120)}`)?.toString(), "long name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runtime build: committed pins.json", () => {
  it("re-recording an archive leaves pins.json as it is (the format Biome keeps)", () => {
    let text = pinsText;
    for (const name of Object.keys(TARGETS)) {
      const recorded = pins.runtimeArchives[name];
      text = recordArchiveSha(text, name, recorded.archive, recorded.sha256);
    }
    assert.equal(text, pinsText);
  });
});

describe("runtime build: portable helpers", () => {
  it("unpacks with System32's bsdtar on Windows and tar elsewhere", () => {
    assert.equal(tarCommand("linux"), "tar");
    assert.equal(tarCommand("darwin", { SystemRoot: "C:\\Windows" }), "tar");
    assert.equal(tarCommand("win32", { SystemRoot: "D:\\Windows\\" }), "D:\\Windows\\System32\\tar.exe");
    assert.equal(tarCommand("win32", {}), "C:\\Windows\\System32\\tar.exe");
  });

  it("compares the committed files as LF, as a Windows checkout may have CRLF", () => {
    assert.equal(lf("opentide==0.21.0\r\nx\r\n"), "opentide==0.21.0\nx\n");
    assert.equal(
      lf(readFileSync(join(root, "runtime", "requirements.in"), "utf8").replaceAll("\n", "\r\n")),
      requirementsIn(pins),
    );
  });

  it(".gitattributes checks every text file out with LF, also on Windows", () => {
    assert.match(readFileSync(join(root, ".gitattributes"), "utf8"), /^\* text=auto eol=lf$/m);
  });

  it("reads uv's version", () => {
    assert.equal(uvVersion("uv 0.11.32 (x86_64-unknown-linux-gnu)\n"), "0.11.32");
    assert.equal(uvVersion("nope"), undefined);
  });
});
