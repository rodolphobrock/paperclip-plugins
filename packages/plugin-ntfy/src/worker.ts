import { createNotifier, validateConfig } from "@paperclip-plugins/notify-core";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseNtfyConfig } from "./config.js";
import { ntfySender } from "./sender.js";

/** Exported for tests, which wait on `notifier.idle()` after emitting events. */
export const notifier = createNotifier({ sender: ntfySender, parseConfig: parseNtfyConfig });

const plugin = definePlugin({
  async setup(ctx) {
    await notifier.setup(ctx);
  },

  async onHealth() {
    return notifier.health();
  },

  // Queues live in plugin state; only in-flight deliveries need to finish.
  async onShutdown() {
    await notifier.idle();
  },

  // Config is read per event, so a saved change needs no worker restart.
  async onConfigChanged(_config, context) {
    notifier.configChanged(context?.companyId ?? null);
  },

  // The host's "Test configuration" passes no company, so this only checks structure;
  // the settings page's "Send test notification" action resolves secrets.
  async onValidateConfig(config) {
    return validateConfig(parseNtfyConfig, config);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
