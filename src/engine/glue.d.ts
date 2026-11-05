// wasm-bindgen's `--target web` glue for language-server's `opentide-wasm` (opentide_wasm.js in the pinned
// opentide-wasm-web zip). The build resolves `opentide-wasm-glue` to that file (scripts/build.mjs); only
// the worker entries import it.
declare module "opentide-wasm-glue" {
  export class LanguageServer {
    constructor();
    handle(message: string): string[];
    readonly closed: boolean;
    free(): void;
  }
  export function version(): string;
  /** Bytes, or a compiled `WebAssembly.Module`. */
  export function initSync(module: { module: Uint8Array | object }): object;
  export default function init(module_or_path?: { module_or_path: unknown }): Promise<object>;
}
