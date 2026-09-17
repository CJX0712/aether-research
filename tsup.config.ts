import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  target: "node22",
  platform: "node",
  // jsdom 含有大量动态 require，必须留在外部；aetherflow 是 peer 级依赖
  external: ["aetherflow", "jsdom"],
  // shebang 写在 src/cli/index.ts 首行，由 esbuild 原样保留
  onSuccess: "chmod +x dist/cli.js dist/cli.cjs",
});
