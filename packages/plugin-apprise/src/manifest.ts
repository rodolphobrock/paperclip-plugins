import { DRAIN_JOB_KEY } from "@paperclip-plugins/notify-core";
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import pkg from "../package.json" with { type: "json" };
import { appriseConfigSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip-plugin-apprise",
  apiVersion: 1,
  version: pkg.version,
  displayName: "Apprise",
  description: "Notifications for Paperclip events to 100+ services via apprise-api.",
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
    "instance.settings.register",
    "jobs.schedule",
    "activity.log.write",
  ],
  jobs: [
    {
      jobKey: DRAIN_JOB_KEY,
      displayName: "Deliver queued notifications",
      description:
        "Retries failed deliveries and sends digests held by quiet hours or the rate limit.",
      schedule: "*/1 * * * *",
    },
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: appriseConfigSchema,
  ui: {
    slots: [
      {
        type: "companySettingsPage",
        id: "apprise-settings",
        displayName: "Apprise",
        exportName: "AppriseSettingsPage",
        routePath: "apprise",
      },
    ],
  },
};

export default manifest;
