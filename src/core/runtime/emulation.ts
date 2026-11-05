// The win32-arm64 package bundles the win32-x64 runtime (pins.json emulatedTargets, docs/PACKAGING.md):
// Windows 11 on Arm runs it under its x64 emulation, Windows 10 on Arm cannot start it. vscode-free.

/**
 * What a bundled runtime that did not answer means on this machine: on Windows on Arm, that the
 * runtime is x64, which only Windows 11 runs. Undefined elsewhere.
 */
export function bundledEmulationHint(
  platform: NodeJS.Platform,
  arch: string | undefined,
): string | undefined {
  if (platform !== "win32" || arch !== "arm64") return undefined;
  return (
    "This package's runtime is x64: Windows 11 on Arm runs it under emulation, Windows 10 on Arm cannot. " +
    "Install opentide in the workspace or set opentide.path."
  );
}
