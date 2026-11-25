# Highlighting contrast fixtures

The data of `test/scripts/highlighting-contrast.test.mjs`. `scripts/highlighting-contrast.mjs` writes what is generated.

- `samples/query/corpus.<language>`: the `*__valid` files of opentide's `crates/testdata/corpus/<language>` at
  v1.0.0, one after the other, without their `prod:` header lines (EUPL-1.2, opentidehq/opentide).
- `samples/yaml/`: opentide's golden rules (`tests/golden/payloads/corpus/objects/rules`: sentinel-full,
  splunk-full, elastic-*, crowdstrike-full, sysdig-full, carbon-black-full, s1-single, harfanglab-yara),
  `microsoft-defender.yaml` (`tests/golden/fixtures/deploy-tenants/objects/rules/microsoft-defender-a-create.yaml`)
  and a Falco workspace rule (`crates/testdata/workspaces/falco`) at v1.0.0 (EUPL-1.2); this
  repository's `suspicious-lsass-access.yaml` and `coretide-rule.yaml`; `markdown-rich.yaml`, a description in
  Markdown and inline queries, written for this test.
- `semantic-tokens.json`: the semantic tokens `opentide lsp start` gives each sample, `[line, character, length,
  type]`. `node scripts/highlighting-contrast.mjs capture <opentide>` rewrites it; the test fails when its version is
  not `pins.json`'s `highlights.version`.
- `baseline.json`: the most of a language's meaningful tokens the grammars alone may leave in the default foreground.
  `node scripts/highlighting-contrast.mjs baseline` rewrites it; lower it when opentide's grammars improve.
- `themes/`: VS Code's default themes, `extensions/theme-defaults/themes/*.json` of microsoft/vscode at
  b57d5c9e1b27c4ede570c76940b7aa5207595a54, unchanged (MIT, `themes/LICENSE.txt`).

`node scripts/highlighting-contrast.mjs report` prints every theme × language × token type: the colour and contrast
before the server answers, and after.
