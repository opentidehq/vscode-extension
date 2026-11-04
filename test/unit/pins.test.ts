import * as assert from "node:assert/strict";
import {
  detectPin,
  pinFromPyproject,
  pinFromRequirement,
  pinFromRequirements,
  pinFromUvLock,
} from "../../src/core/runtime/pins";

describe("repository pins", () => {
  it("counts only exact pins of opentide", () => {
    assert.equal(pinFromRequirement("opentide==0.20.1"), "0.20.1");
    assert.equal(pinFromRequirement("opentide[mcp] == 0.20.1 ; python_version >= '3.10'"), "0.20.1");
    assert.equal(pinFromRequirement("opentide>=0.20"), undefined);
    assert.equal(pinFromRequirement("opentide==0.20.*"), undefined);
    assert.equal(pinFromRequirement("opentide-extras==1.0"), undefined);
  });

  it("reads requirements files, skipping comments and options", () => {
    assert.equal(
      pinFromRequirements("# tools\n-r base.txt\nruff==0.6\nopentide==0.20.1  # pinned\n"),
      "0.20.1",
    );
    assert.equal(pinFromRequirements("opentide\n"), undefined);
  });

  it("reads pyproject.toml dependency strings", () => {
    const pyproject = `[project]\nname = "detections"\ndependencies = [\n  "requests>=2",\n  "opentide==0.20.1",\n]\n`;
    assert.equal(pinFromPyproject(pyproject), "0.20.1");
    assert.equal(pinFromPyproject(`[dependency-groups]\ndev = ['opentide==0.19.0']\n`), "0.19.0");
    assert.equal(pinFromPyproject(`dependencies = ["opentide>=0.20"]`), undefined);
  });

  it("reads the resolved version from uv.lock", () => {
    const lock = `version = 1\n\n[[package]]\nname = "httpx"\nversion = "0.28.1"\n\n[[package]]\nname = "opentide"\nversion = "0.20.1"\nsource = { registry = "https://pypi.org/simple" }\n`;
    assert.equal(pinFromUvLock(lock), "0.20.1");
    assert.equal(pinFromUvLock(`[[package]]\nname = "other"\nversion = "1"\n`), undefined);
  });

  it("prefers uv.lock, then requirements*.txt, then pyproject.toml", () => {
    assert.deepEqual(
      detectPin({
        "pyproject.toml": `dependencies = ["opentide==0.19.0"]`,
        "requirements.txt": "opentide==0.20.0",
        "uv.lock": `[[package]]\nname = "opentide"\nversion = "0.20.1"\n`,
      }),
      { version: "0.20.1", source: "uv.lock" },
    );
    assert.deepEqual(
      detectPin({ "pyproject.toml": `x = ["opentide==0.19.0"]`, "requirements-dev.txt": "opentide==0.20.0" }),
      {
        version: "0.20.0",
        source: "requirements-dev.txt",
      },
    );
    assert.equal(detectPin({ "README.md": "opentide==1" }), undefined);
  });
});
