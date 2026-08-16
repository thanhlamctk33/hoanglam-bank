import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The suite is deliberately unit-level: every module that reaches Prisma
    // is mocked, so `npm test` runs without a database or a generated client.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      JWT_SECRET: "test-secret-value-not-used",
    },
  },
});
