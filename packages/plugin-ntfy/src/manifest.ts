import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import pkg from "../package.json" with { type: "json" };
import { ntfyConfigSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-ntfy",
  apiVersion: 1,
  version: pkg.version,
  displayName: "ntfy",
  description: "Push notifications for Paperclip events via ntfy.",
  author: "Rodolpho Brock",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "companies.read",
    "approvals.read",
    "agents.read",
    "issues.read",
    "metrics.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: ntfyConfigSchema,
};

export default manifest;
