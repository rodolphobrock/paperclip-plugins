import { defineConfig } from "vitest/config";

// Against real services (examples/notify/docker-compose.yml); see the root README.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.int.spec.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
