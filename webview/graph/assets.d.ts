// The codicon SVGs the graph draws on its canvas, imported as text (the `.svg` loader, scripts/build.mjs).
declare module "*.svg" {
  const text: string;
  export default text;
}
