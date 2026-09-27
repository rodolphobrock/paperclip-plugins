import { createSettingsPage } from "@paperclip-plugins/notify-core/ui";

export const AppriseSettingsPage = createSettingsPage("Apprise", {
  setupHint: "set the apprise-api URL and a configuration key or destinations",
});
