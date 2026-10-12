// esbuild loads stylesheets as text (build.mjs → loader), so view.ts can inject MapLibre's CSS itself.
declare module "*.css" {
  const text: string;
  export default text;
}
