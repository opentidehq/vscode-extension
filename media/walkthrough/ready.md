# opentide is ready

The extension runs the opentide you install: `pip install opentide` (or `uv tool install opentide`) in the repository's environment, so the editor checks what CI checks. Until one answers, the opentide engine (WASM) gives the editor features: diagnostics, hover, completion and the Catalogue.

The status bar item says which opentide runs and where it comes from. Click it for the runtime menu.

| When the repository… | The extension uses |
|----------------------|--------------------|
| sets `opentide.path` | that executable |
| pins a version, with `opentide.uv.usePin` | `uv tool run --from opentide==<pin>` |
| has opentide in its environment (`opentide.interpreter`, the Python extension's interpreter, `.venv`) | its `opentide` command, else `python -m opentide` |
| has opentide on `PATH`, or a `python` on `PATH` with opentide installed | `opentide`, else `python -m opentide` |
| has none of these | the opentide engine (WASM), for editor features only |

`python -m opentide` covers a machine where the `opentide` command cannot run: a `pip install --user` whose scripts folder is not on `PATH`, or a policy that blocks the `opentide` launcher but allows Python. New terminals then get an `opentide` command that runs it (`opentide.terminal.addToPath`).

In Restricted Mode only the opentide engine (WASM) runs.
