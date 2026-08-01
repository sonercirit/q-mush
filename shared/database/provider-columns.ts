import { integer, text } from "drizzle-orm/sqlite-core";
import { MODEL_PROVIDER_IDS } from "../provider-id.ts";

export function connectionColumns() {
  return {
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    isGlobal: integer("is_global", { mode: "boolean" }).notNull().default(true),
  };
}

export function providerColumn() {
  return text("provider", { enum: MODEL_PROVIDER_IDS }).notNull();
}

export function credentialProviderColumn() {
  return text("provider", {
    enum: [...MODEL_PROVIDER_IDS, "brave_search"],
  }).notNull();
}
