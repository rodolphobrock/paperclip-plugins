import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import esbuild from "esbuild";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

const contexts = await Promise.all([
  esbuild.context(presets.esbuild.worker),
  esbuild.context(presets.esbuild.manifest),
  ...(presets.esbuild.ui ? [esbuild.context(presets.esbuild.ui)] : []),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("esbuild watching worker, manifest and ui");
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
