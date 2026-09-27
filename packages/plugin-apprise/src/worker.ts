import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { SEVERITIES } from "@rodolphobrock/paperclip-notify-core";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("apprise notifier loaded (scaffold, no events handled yet)");
  },

  async onHealth() {
    return {
      status: "ok",
      message: `apprise notifier scaffold; severities: ${SEVERITIES.join(", ")}`,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
