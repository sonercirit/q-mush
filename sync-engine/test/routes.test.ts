import { expect, test } from "vitest";
import {
  API_BASE_PATH,
  AUTH_GOOGLE_CALLBACK_PATH,
  AUTH_GOOGLE_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_SESSION_PATH,
  BRAVE_SEARCH_KEYS_PATH,
  FAVICON_PATH,
  GENERIC_CREDENTIALS_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_CALLBACK_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_CALLBACK_PATH,
  OPENROUTER_OAUTH_PATH,
  promptPath,
  PROMPTS_PATH,
  providerCredentialDefaultPath,
  REALTIME_PATH,
  RUNNER_EXECUTABLE_PATH,
  RUNNER_INSTALLER_PATH,
  RUNNER_REALTIME_PATH,
  RUNNER_VERSION_HEADER,
  runnerDefaultPath,
  runnerDirectoriesPath,
  RUNNERS_PATH,
  SESSIONS_PATH,
} from "../../shared/routes.ts";

test("places every endpoint beneath its expected base path", () => {
  expect(API_BASE_PATH).toBe("/api");
  expect(AUTH_GOOGLE_PATH).toBe("/api/auth/google");
  expect(AUTH_GOOGLE_CALLBACK_PATH).toBe("/api/auth/google/callback");
  expect(AUTH_LOGOUT_PATH).toBe("/api/auth/logout");
  expect(AUTH_SESSION_PATH).toBe("/api/auth/session");
  expect(BRAVE_SEARCH_KEYS_PATH).toBe("/api/skills/brave-search/keys");
  expect(FAVICON_PATH).toBe("/favicon.svg");
  expect(GENERIC_CREDENTIALS_PATH).toBe("/api/generic/credentials");
  expect(OPENAI_CREDENTIALS_PATH).toBe("/api/openai/credentials");
  expect(
    providerCredentialDefaultPath(OPENAI_CREDENTIALS_PATH, "credential/id"),
  ).toBe("/api/openai/credentials/credential%2Fid/default");
  expect(OPENAI_OAUTH_PATH).toBe("/api/openai/oauth");
  expect(OPENAI_OAUTH_CALLBACK_PATH).toBe("/api/openai/oauth/callback");
  expect(OPENROUTER_CREDENTIALS_PATH).toBe("/api/openrouter/credentials");
  expect(OPENROUTER_OAUTH_PATH).toBe("/api/openrouter/oauth");
  expect(OPENROUTER_OAUTH_CALLBACK_PATH).toBe("/api/openrouter/oauth/callback");
  expect(PROMPTS_PATH).toBe("/api/prompts");
  expect(promptPath("prompt/id")).toBe("/api/prompts/prompt%2Fid");
  expect(RUNNERS_PATH).toBe("/api/runners");
  expect(runnerDefaultPath("runner/id")).toBe(
    "/api/runners/runner%2Fid/default",
  );
  expect(runnerDirectoriesPath("runner/id")).toBe(
    "/api/runners/runner%2Fid/directories",
  );
  expect(RUNNER_REALTIME_PATH).toBe("/api/runner/realtime");
  expect(REALTIME_PATH).toBe("/api/realtime");
  expect(RUNNER_VERSION_HEADER).toBe("x-q-mush-runner-version");
  expect(SESSIONS_PATH).toBe("/api/sessions");
  expect(RUNNER_INSTALLER_PATH).toBe("/runner/install.sh");
  expect(RUNNER_EXECUTABLE_PATH).toBe("/runner/executable");
});
