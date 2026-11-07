import { build } from "esbuild";

await build({
  entryPoints: ["src/auto.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/portal-runtime.js",
});
