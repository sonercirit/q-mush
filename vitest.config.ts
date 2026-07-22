import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    solid({
      exclude: [/shared\/server-rendering\//u],
      ssr: true,
    }),
  ],
  test: {
    environment: "node",
    include: ["**/test/**/*.test.{ts,tsx}"],
    testTimeout: 15_000,
  },
});
