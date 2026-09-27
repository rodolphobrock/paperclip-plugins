import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import esbuild from "esbuild";

const presets = createPluginBundlerPresets();
const watch = process.argv.includes("--watch");

const contexts = await Promise.all([
  esbuild.context(presets.esbuild.worker),
  esbuild.context(presets.esbuild.manifest),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("esbuild watching worker and manifest");
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
