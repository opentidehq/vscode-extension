// Times `require(dist/extension.js)` the way an extension host does at startup, with a stand-in for `vscode`: the part
// of activation that every window pays, including a dormant one that never starts a language client.
//
//   node scripts/bench-require.mjs [dist/extension.js] [runs=15]
//
// Each run is a fresh node process; prints one JSON line with the min, median and max in milliseconds
// (vscode-stand-in.mjs says what the stand-in is). The numbers are the machine's: compare two bundles on one machine.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { failure, runWithStandIn } from "./vscode-stand-in.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TIMED = `
const started = process.hrtime.bigint();
require(process.argv[1]);
process.stdout.write(String(Number(process.hrtime.bigint() - started) / 1e6));
`;

export function timeRequire(bundle, runs = 15) {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const result = runWithStandIn(TIMED, bundle);
    if (result.status !== 0) throw new Error(`require(${bundle}) failed: ${failure(result)}`);
    times.push(Number(result.stdout));
  }
  times.sort((a, b) => a - b);
  return {
    runs,
    minMs: times[0],
    medianMs: times[Math.floor(times.length / 2)],
    maxMs: times[times.length - 1],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , bundle = join(root, "dist", "extension.js"), runs = "15"] = process.argv;
  const { minMs, medianMs, maxMs } = timeRequire(resolve(bundle), Number(runs));
  console.log(JSON.stringify({ bundle: resolve(bundle), runs: Number(runs), minMs, medianMs, maxMs }));
}
