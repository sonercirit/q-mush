import { defineConfig } from "drizzle-kit";
import { readDatabasePath } from "./shared/database/config.ts";

export default defineConfig({
  dbCredentials: {
    url: readDatabasePath(process.env),
  },
  dialect: "sqlite",
  out: "./drizzle",
  schema: "./shared/database/schema.ts",
  strict: true,
});
