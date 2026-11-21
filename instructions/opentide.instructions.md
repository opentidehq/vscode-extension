---
name: opentide
description: How to work in an opentide detection repository (threats, objectives, rules): use the opentide MCP tools, validate before deploying, and never deploy for real unless asked.
---

# Working in an opentide repository

- **Use the opentide MCP server's tools** instead of guessing at the repository: `search` to find threats, objectives and rules, `validate_rule` and `validation_report` to check them, `coverage` for what is covered. If the server is not listed, say so rather than inventing its output.
- **Validate before you deploy.** Run validation after every change to an object and fix what it reports before moving on. Keep to the order the model implies: threats, then objectives that detect them, then rules that implement the objectives. Do not mix object types in one change.
- **Never deploy for real unless the user asks.** `deploy_rule` with `dry_run: false` changes a real tenant. Use `dry_run: true` (the default way to preview) and show the user what would change. The same care applies to `run_query` and `validate_query` with `live: true`, which contact a tenant.
- **Use what the repository gives you.** Take intelligence and structure from its objects and templates, not from memory, and do not change schemas, templates or configuration files unless asked.
- Platform skills (`opentide-rule`, `kusto-query-language`, and the others) carry the detail; load the one that matches the platform you are writing for.
