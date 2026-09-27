import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import pkg from "../package.json" with { type: "json" };

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-apprise",
  apiVersion: 1,
  version: pkg.version,
  displayName: "Apprise",
  description: "Notifications for Paperclip events to 100+ services via apprise-api.",
  author: "Rodolpho Brock",
  categories: ["connector"],
  capabilities: ["events.subscribe"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
