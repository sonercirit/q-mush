import { integer, text } from "drizzle-orm/sqlite-core";

export function connectionColumns() {
  return {
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    isGlobal: integer("is_global", { mode: "boolean" }).notNull().default(true),
  };
}

export function providerColumn() {
  return text("provider", { enum: ["openai", "openrouter"] }).notNull();
}

export function credentialProviderColumn() {
  return text("provider", {
    enum: ["openai", "openrouter", "brave_search"],
  }).notNull();
}
