import { describe, expect, test } from "vitest";
import {
  buildClientJavaScript,
  buildClientStylesheet,
  readQmushPort,
} from "../../sync-engine/server.ts";

test("uses port 12345 unless PORT overrides it", () => {
  expect(readQmushPort({})).toBe(12_345);
  expect(readQmushPort({ PORT: "23456" })).toBe("23456");
});

describe("browser build", () => {
  test("builds the login, session, and provider credential controls", async () => {
    const javaScript = await buildClientJavaScript();

    expect(javaScript).toContain("Continue with Google");
    expect(javaScript).toContain("Connect OpenAI account");
    expect(javaScript).toContain("Connect OpenRouter account");
    expect(javaScript).toContain("Brave Search");
    expect(javaScript).toContain("Add API key");
    expect(javaScript).toContain("Set up a runner");
    expect(javaScript).toContain("Download installer");
    expect(javaScript).toContain("New agent session");
    expect(javaScript).toContain("Stop session");
    expect(javaScript).toContain("AUTH_GOOGLE_PATH");
    expect(javaScript).toContain("AUTH_LOGOUT_PATH");
    expect(javaScript).toContain("OPENAI_CREDENTIALS_PATH");
    expect(javaScript).toContain("OPENROUTER_CREDENTIALS_PATH");
    expect(javaScript).toContain("BRAVE_SEARCH_KEYS_PATH");
    expect(javaScript).toContain("RUNNERS_PATH");
    expect(javaScript).toContain("SESSIONS_PATH");
  });
});

describe("stylesheet build", () => {
  test("builds the Tailwind stylesheet in memory", async () => {
    const css = await buildClientStylesheet();

    expect(css).toContain("tailwindcss");
    expect(css).toContain(".min-h-screen");
    expect(css).toContain(".bg-slate-950");
  });
});
