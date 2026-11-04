# opentide for VS Code

The opentide workbench for VS Code and its forks. It gives detection engineers:

- live checks for Tide objects and their KQL, SPL, ES|QL, EQL, Kibana KQL, Lucene and Falco queries;
- new objects from templates;
- a catalogue, graph and ATT&CK coverage of how detections connect;
- query results and deploy previews;
- an MCP server for agents.

It works on install, with a bundled opentide runtime, and uses the workspace's own opentide when there is one.

**Status:** not started. The design is [`docs/SPEC.md`](docs/SPEC.md); the work is tracked in the [epic](https://github.com/opentidehq/vscode-extension/issues/1).

Related: [opentidehq/opentide](https://github.com/opentidehq/opentide) (the CLI, models and MCP server) · [opentidehq/language-server](https://github.com/opentidehq/language-server) (the analysis engine and language server; editor contract in its `docs/EDITORS.md`).
