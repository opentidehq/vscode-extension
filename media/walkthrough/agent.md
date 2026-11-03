# Bring your agent

**VS Code:** the extension provides opentide's MCP server to every agent in VS Code, with the runtime it resolved. There is no `.vscode/mcp.json` to write.

**Cursor, Claude Code and other hosts:** **Bring Your Agent…** opens the setup wizard on its Agents step, which runs `opentide setup mcp` for them, and installs agent skills with `opentide setup skills`.

**Skills:** the opentidehq/skills Agent Plugin teaches an agent how to write and check detections the opentide way.
