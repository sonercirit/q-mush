import { defineConfig } from "drizzle-kit";
import { readDatabasePath } from "./src/database/config.ts";

export default defineConfig({
  dbCredentials: {
    url: readDatabasePath(process.env),
  },
  dialect: "sqlite",
  out: "./drizzle",
  schema: "./src/database/schema.ts",
  strict: true,
});
