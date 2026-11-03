# Preview a deploy

**Preview a Deploy** runs `opentide deploy --dry-run`: the payload each rule would send to each tenant, without sending anything.

The editor previews; CI deploys. A real deploy, `share push` and `share retract` are reviewed CI steps, so the extension offers none of them from a menu.

Tenants and their credentials are in the sidebar's **Platforms & Tenants** view. **Set Credential…** stores a secret in VS Code's secret storage and passes it only to commands that contact that tenant. It is never written to a file.
