// Files the webview bundle imports through esbuild loaders (scripts/build.mjs).
declare module "*.svg" {
  const text: string;
  export default text;
}
declare module "*.css";
