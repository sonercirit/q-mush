export const API_BASE_PATH = "/api";
export const REALTIME_PATH = `${API_BASE_PATH}/realtime`;
export const APP_PATH = "/app";
export const APP_SCRIPT_PATH = "/app.js";
const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;
export const AUTH_GOOGLE_PATH = `${AUTH_BASE_PATH}/google`;
export const AUTH_GOOGLE_CALLBACK_PATH = `${AUTH_GOOGLE_PATH}/callback`;
export const AUTH_LOGOUT_PATH = `${AUTH_BASE_PATH}/logout`;
export const AUTH_SESSION_PATH = `${AUTH_BASE_PATH}/session`;
const BRAVE_SEARCH_BASE_PATH = `${API_BASE_PATH}/skills/brave-search`;
export const BRAVE_SEARCH_KEYS_PATH = `${BRAVE_SEARCH_BASE_PATH}/keys`;
export const FAVICON_PATH = "/favicon.svg";
export const HOME_PATH = "/";
const OPENAI_BASE_PATH = `${API_BASE_PATH}/openai`;
export const OPENAI_CREDENTIALS_PATH = `${OPENAI_BASE_PATH}/credentials`;
export const OPENAI_OAUTH_PATH = `${OPENAI_BASE_PATH}/oauth`;
export const OPENAI_OAUTH_CALLBACK_PATH = `${OPENAI_OAUTH_PATH}/callback`;
const OPENROUTER_BASE_PATH = `${API_BASE_PATH}/openrouter`;
export const OPENROUTER_CREDENTIALS_PATH = `${OPENROUTER_BASE_PATH}/credentials`;
export const OPENROUTER_OAUTH_PATH = `${OPENROUTER_BASE_PATH}/oauth`;
export const OPENROUTER_OAUTH_CALLBACK_PATH = `${OPENROUTER_OAUTH_PATH}/callback`;
export function providerCredentialDefaultPath(
  credentialsPath: string,
  credentialId: string,
): string {
  return `${credentialsPath}/${encodeURIComponent(credentialId)}/default`;
}
export const RUNNERS_PATH = `${API_BASE_PATH}/runners`;
export function runnerDefaultPath(runnerId: string): string {
  return `${RUNNERS_PATH}/${encodeURIComponent(runnerId)}/default`;
}
export const RUNNER_DIRECTORIES_SEGMENT = "directories";
export function runnerDirectoriesPath(runnerId: string): string {
  return `${RUNNERS_PATH}/${encodeURIComponent(runnerId)}/${RUNNER_DIRECTORIES_SEGMENT}`;
}
const RUNNER_BASE_PATH = `${API_BASE_PATH}/runner`;
export const RUNNER_REALTIME_PATH = `${RUNNER_BASE_PATH}/realtime`;
export const RUNNER_VERSION_HEADER = "x-q-mush-runner-version";
export const RUNNER_INSTALLER_PATH = "/runner/install.sh";
export const RUNNER_EXECUTABLE_PATH = "/runner/executable";
export const RUNNER_EXECUTABLE_SHA256_HEADER = "x-q-mush-runner-sha256";
export const SESSIONS_PATH = `${API_BASE_PATH}/sessions`;
export const SESSION_MODELS_PATH = `${SESSIONS_PATH}/models`;
export const STYLESHEET_PATH = "/styles.css";
