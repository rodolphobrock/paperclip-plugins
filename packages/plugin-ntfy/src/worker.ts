import { createNotifier, validateConfig } from "@paperclip-plugins/notify-core";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseNtfyConfig } from "./config.js";
import { ntfySender } from "./sender.js";

const notifier = createNotifier({ sender: ntfySender, parseConfig: parseNtfyConfig });

const plugin = definePlugin({
  async setup(ctx) {
    await notifier.setup(ctx);
  },

  async onHealth() {
    return { status: "ok" };
  },

  // The host's "Test configuration" passes no company, so this only checks structure;
  // the settings page's "Send test notification" action resolves secrets.
  async onValidateConfig(config) {
    return validateConfig(parseNtfyConfig, config);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
