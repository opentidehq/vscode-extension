# opentide is ready

The extension ships with its own opentide, so it works on install: no Python, no `pip`, offline. A few features need a newer opentide than the bundled one: the graph and the ATT&CK matrix (`info catalog`), tenants in the Platforms view, and the setup wizard's review of what it will write.

The status bar item says which opentide runs and where it comes from. Click it for the runtime menu.

| When the repository… | The extension uses |
|----------------------|--------------------|
| sets `opentide.path` | that executable |
| has opentide in its environment (`.venv`, the Python extension's interpreter, `PATH`) | that opentide, so the editor checks what CI checks |
| pins a version, with `opentide.uv.usePin` | `uv tool run --from opentide==<pin>` |
| has none of these | the bundled opentide |

In Restricted Mode only the language server runs, from the bundled runtime.
