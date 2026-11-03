// The setup wizard's answers, and the `opentide setup` commands they become (SPEC §8, #16). The wizard
// is a form over these flags (D3): it writes nothing itself. vscode-free.
import { displayArgv } from "../../core/runtime/env";
import {
  type CiProvider,
  MCP_HOSTS,
  type McpHost,
  type SetupAnswers,
  type SetupMode,
  SKILLS_HOSTS,
  type SkillsHost,
} from "./protocol";

export type { CiProvider, McpHost, SetupAnswers, SetupMode, SkillsHost } from "./protocol";

/** What the active opentide's `setup` accepts (from `opentide --json commands`). */
export interface OptionSource {
  hasCommand(path: string): boolean;
  hasOption(path: string, flag: string): boolean;
  /** The choices of an option, when it has them. */
  choices(path: string, flag: string): readonly string[] | undefined;
}

export interface SetupSupport {
  /** `setup --plan` (opentide#751): Review lists the files. */
  readonly plan: boolean;
  /** `--plan` on the subcommands too (an existing repository's plan). */
  readonly subcommandPlan: boolean;
  /** Flags on `setup` itself; the others run as their own subcommand. */
  readonly setupFlags: {
    readonly mcp: boolean;
    readonly skills: boolean;
    readonly plugin: boolean;
    readonly hooks: boolean;
    readonly env: boolean;
  };
  readonly platforms: readonly string[];
  readonly ciProviders: readonly CiProvider[];
  readonly mcpHosts: readonly McpHost[];
  readonly skillsHosts: readonly SkillsHost[];
  readonly plugin: boolean;
  readonly hooks: boolean;
  readonly env: boolean;
  readonly explorerPages: boolean;
  readonly promotion: boolean;
}

export const DEFAULT_PLATFORMS = [
  "sentinel",
  "defender_for_endpoint",
  "splunk",
  "elastic",
  "crowdstrike",
  "sentinel_one",
  "carbon_black_cloud",
  "harfanglab",
  "sysdig",
];

/** The wizard's choices, read from the command tree (never from a version number). */
export function setupSupport(tree: OptionSource): SetupSupport {
  const ci = tree
    .choices("setup", "--ci")
    ?.filter((c): c is CiProvider => ["github", "gitlab", "azure", "none"].includes(c));
  return {
    plan: tree.hasOption("setup", "--plan"),
    subcommandPlan: tree.hasOption("setup platforms", "--plan"),
    setupFlags: {
      mcp: tree.hasOption("setup", "--mcp"),
      skills: tree.hasOption("setup", "--skills"),
      plugin: tree.hasOption("setup", "--plugin"),
      hooks: tree.hasOption("setup", "--hooks"),
      env: tree.hasOption("setup", "--env"),
    },
    platforms: tree.choices("setup", "--platform") ?? DEFAULT_PLATFORMS,
    ciProviders: ci && ci.length > 0 ? ci : ["github", "gitlab", "azure", "none"],
    mcpHosts: MCP_HOSTS.filter((host) => tree.hasOption("setup mcp", `--${host}`)),
    skillsHosts: SKILLS_HOSTS.filter((host) => tree.hasOption("setup skills", `--${host}`)),
    plugin: tree.hasOption("setup skills", "--plugin"),
    hooks: tree.hasCommand("setup hooks"),
    env: tree.hasCommand("setup env"),
    explorerPages: tree.hasOption("setup", "--explorer-pages"),
    promotion: tree.hasOption("setup", "--promotion"),
  };
}

export function defaultAnswers(folderName: string): SetupAnswers {
  return {
    name: folderName,
    org: "",
    description: "",
    platforms: [],
    ci: "github",
    staging: true,
    inflight: true,
    sharing: false,
    explorerPages: false,
    pythonVersion: "3.12",
    defaultBranch: "",
    // VS Code needs no MCP file: the extension provides the server (SPEC §12).
    mcp: [],
    skills: [],
    plugin: false,
    hooks: true,
    env: true,
  };
}

/** Problems that stop Review, per step (1-based, as the stepper numbers them). */
export function validateAnswers(
  answers: SetupAnswers,
  mode: SetupMode,
  enabled: readonly string[] = [],
): { step: number; message: string }[] {
  const problems: { step: number; message: string }[] = [];
  if (mode === "new" && !answers.name.trim())
    problems.push({ step: 1, message: "Give the repository a name." });
  if (mode === "new" && answers.platforms.length === 0)
    problems.push({ step: 2, message: "Pick at least one platform." });
  if (answers.pythonVersion.trim() && !/^3\.\d{1,2}$/.test(answers.pythonVersion.trim()))
    problems.push({ step: 3, message: "The Python version looks like 3.12." });
  if (answers.defaultBranch.trim() && /[\s~^:?*[\\]/.test(answers.defaultBranch.trim()))
    problems.push({ step: 3, message: "That is not a valid branch name." });
  if (mode === "existing" && nothingToDo(answers, enabled))
    problems.push({ step: 2, message: "Pick something to add: a platform, CI, an agent or an extra." });
  return problems;
}

function nothingToDo(answers: SetupAnswers, enabled: readonly string[]): boolean {
  return (
    answers.platforms.every((p) => enabled.includes(p)) &&
    answers.ci === "none" &&
    answers.mcp.length === 0 &&
    answers.skills.length === 0 &&
    !answers.plugin &&
    !answers.hooks &&
    !answers.env
  );
}

/** One `opentide setup …` command Apply runs, with `--yes`. */
export interface SetupCommand {
  /** The step it stands for (`setup`, `platforms`, `ci`, `env`, `hooks`, `mcp`, `skills`). */
  readonly step: string;
  readonly argv: readonly string[];
  /** What it does, for Review when this opentide has no `--plan`. */
  readonly summary: string;
}

function ciFlags(answers: SetupAnswers, support: SetupSupport): string[] {
  const flags = [
    answers.staging ? "--staging" : "--no-staging",
    answers.inflight ? "--inflight" : "--no-inflight",
    answers.sharing ? "--sharing" : "--no-sharing",
  ];
  if (answers.promotion !== undefined && support.promotion)
    flags.push(answers.promotion ? "--promotion" : "--no-promotion");
  if (answers.ci === "github" && support.explorerPages)
    flags.push(answers.explorerPages ? "--explorer-pages" : "--no-explorer-pages");
  const python = answers.pythonVersion.trim();
  if (python && python !== "3.12") flags.push("--python-version", python);
  const branch = answers.defaultBranch.trim();
  if (branch) flags.push("--default-branch", branch);
  return flags;
}

const list = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * The commands, in the order setup runs its steps (repo, platforms, ci, env, hooks, mcp, skills). With
 * opentide#751 a new repository is one `setup` command; before it, mcp, skills, hooks and env run as
 * their own subcommands. An existing repository runs only the subcommands it needs.
 */
export function setupCommands(
  answers: SetupAnswers,
  mode: SetupMode,
  support: SetupSupport,
  enabled: readonly string[] = [],
): SetupCommand[] {
  const commands: SetupCommand[] = [];
  const own =
    mode === "new"
      ? support.setupFlags
      : { mcp: false, skills: false, plugin: false, hooks: false, env: false };
  const mcp = answers.mcp.filter((h) => support.mcpHosts.includes(h));
  const skills = answers.skills.filter((h) => support.skillsHosts.includes(h));
  const plugin = answers.plugin && support.plugin;
  // Skills and the plugin go together: on `setup` when it takes both, else as `setup skills`.
  const skillsInSetup = own.skills && (!plugin || own.plugin);
  if (mode === "new") {
    const argv = ["setup", "--name", answers.name.trim()];
    if (answers.org.trim()) argv.push("--org", answers.org.trim());
    if (answers.description.trim()) argv.push("--description", answers.description.trim());
    for (const platform of answers.platforms) argv.push("--platform", platform);
    if (answers.ci !== "none") argv.push("--ci", answers.ci, ...ciFlags(answers, support));
    if (own.env && answers.env) argv.push("--env");
    if (own.hooks && answers.hooks) argv.push("--hooks");
    if (own.mcp) for (const host of mcp) argv.push("--mcp", host);
    if (skillsInSetup) for (const host of skills) argv.push("--skills", host);
    if (skillsInSetup && plugin) argv.push("--plugin");
    argv.push("--yes");
    const extras = [
      own.env && answers.env ? ".env.example" : "",
      own.hooks && answers.hooks ? "validate-on-commit hooks" : "",
      own.mcp && mcp.length ? `MCP for ${list(mcp)}` : "",
      skillsInSetup && skills.length ? `skills for ${list(skills)}` : "",
      skillsInSetup && plugin ? "the Agent Plugin" : "",
    ].filter(Boolean);
    commands.push({
      step: "setup",
      argv,
      summary:
        `Scaffold ${answers.name.trim() || "the repository"} (README, .gitignore, objects/, .opentide/) with ` +
        `${list(answers.platforms) || "no platform"}` +
        `${answers.ci !== "none" ? `, and a ${answers.ci} pipeline` : ""}` +
        `${extras.length ? `, ${list(extras)}` : ""}.`,
    });
  } else {
    const added = answers.platforms.filter((p) => !enabled.includes(p));
    if (added.length)
      commands.push({
        step: "platforms",
        argv: ["setup", "platforms", ...added.map((p) => `--${p.replaceAll("_", "-")}`), "--yes"],
        summary: `Enable ${list(added)}: their .opentide/configurations/platforms/*.toml.`,
      });
    if (answers.ci !== "none")
      commands.push({
        step: "ci",
        argv: ["setup", "ci", answers.ci, ...ciFlags(answers, support), "--yes"],
        summary: `Write the ${answers.ci} pipeline.`,
      });
  }
  if (answers.env && support.env && !own.env)
    commands.push({
      step: "env",
      argv: ["setup", "env", "--yes"],
      summary: "Write .env.example and add .env to .gitignore.",
    });
  if (answers.hooks && support.hooks && !own.hooks)
    commands.push({
      step: "hooks",
      argv: ["setup", "hooks", "--yes"],
      summary: "Write .pre-commit-config.yaml and a hook that validates objects on every commit.",
    });
  if (mcp.length && !own.mcp)
    commands.push({
      step: "mcp",
      argv: ["setup", "mcp", ...mcp.map((h) => `--${h}`), "--yes"],
      summary: `Write MCP configuration for ${list(mcp)}.`,
    });
  if ((skills.length || plugin) && !skillsInSetup)
    commands.push({
      step: "skills",
      argv: ["setup", "skills", ...skills.map((h) => `--${h}`), ...(plugin ? ["--plugin"] : []), "--yes"],
      summary: `Install agent skills${skills.length ? ` for ${list(skills)}` : ""}${plugin ? " and register the Agent Plugin" : ""}.`,
    });
  return commands;
}

/** The same commands as a plan: `--plan` instead of `--yes` (opentide#751). */
export function planArgv(command: SetupCommand): string[] {
  return [...command.argv.filter((arg) => arg !== "--yes"), "--plan"];
}

/** Can Review show this command's files? */
export function canPlan(command: SetupCommand, support: SetupSupport): boolean {
  return command.step === "setup" ? support.plan : support.subcommandPlan;
}

/** "Copy as script": the commands as a shell script, to run in the repository. */
export function script(commands: readonly SetupCommand[], folder: string): string {
  const lines = commands.map((c) => `opentide ${displayArgv(c.argv).replace(/^opentide --json /, "")}`);
  return [
    "#!/bin/sh",
    "# opentide setup, as the VS Code wizard ran it",
    "set -e",
    `cd ${displayArgv([folder]).replace(/^opentide --json /, "")}`,
    ...lines,
    "",
  ].join("\n");
}
