import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-apprise",
  apiVersion: 1,
  version: "0.0.0",
  displayName: "Apprise",
  description: "Notifications for Paperclip events to 100+ services via apprise-api.",
  author: "Rodolpho Brock",
  categories: ["connector"],
  minimumHostVersion: "2026.916.1",
  capabilities: ["events.subscribe"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
