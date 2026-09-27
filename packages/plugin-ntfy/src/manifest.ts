import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-ntfy",
  apiVersion: 1,
  version: "0.0.0",
  displayName: "ntfy",
  description: "Push notifications for Paperclip events via ntfy.",
  author: "Rodolpho Brock",
  categories: ["connector"],
  minimumHostVersion: "2026.916.1",
  capabilities: ["events.subscribe"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
};

export default manifest;
