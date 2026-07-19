import { RUNNER_SCRIPT_PATH } from "./routes.ts";

export function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderRunnerInstaller(
  serverOrigin: string,
  token: string,
): string {
  const origin = quoteShellValue(serverOrigin);
  const runnerUrl = quoteShellValue(
    new URL(RUNNER_SCRIPT_PATH, serverOrigin).toString(),
  );
  const setupToken = quoteShellValue(token);

  return `#!/bin/sh
set -eu

SERVER_ORIGIN=${origin}
RUNNER_TOKEN=${setupToken}
INSTALL_DIR="\${Q_MUSH_RUNNER_HOME:-$HOME/.q-mush/runner}"
RUNNER_FILE="$INSTALL_DIR/q-mush-runner.js"
CONFIG_FILE="$INSTALL_DIR/config"
PID_FILE="$INSTALL_DIR/runner.pid"
LOG_FILE="$INSTALL_DIR/runner.log"

if ! command -v curl >/dev/null 2>&1; then
  echo "Q Mush runner setup needs curl." >&2
  exit 1
fi

BUN_COMMAND="$(command -v bun || true)"
if [ -z "$BUN_COMMAND" ]; then
  echo "Installing Bun for the Q Mush runner…"
  curl -fsSL https://bun.sh/install | bash
  BUN_COMMAND="$HOME/.bun/bin/bun"
fi

if [ ! -x "$BUN_COMMAND" ]; then
  echo "Bun could not be found after installation." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
TEMP_RUNNER="$RUNNER_FILE.tmp"
trap 'rm -f "$TEMP_RUNNER"' EXIT HUP INT TERM
curl -fsSL ${runnerUrl} -o "$TEMP_RUNNER"
mv "$TEMP_RUNNER" "$RUNNER_FILE"
printf '%s\\n%s\\n' "$SERVER_ORIGIN" "$RUNNER_TOKEN" > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  RUNNING_COMMAND="$(ps -p "$OLD_PID" -o command= 2>/dev/null || true)"
  case "$RUNNING_COMMAND" in
    *"$RUNNER_FILE"*) kill "$OLD_PID" 2>/dev/null || true ;;
  esac
fi

nohup "$BUN_COMMAND" "$RUNNER_FILE" --config "$CONFIG_FILE" >> "$LOG_FILE" 2>&1 &
RUNNER_PID=$!
printf '%s\\n' "$RUNNER_PID" > "$PID_FILE"
sleep 1

if ! kill -0 "$RUNNER_PID" 2>/dev/null; then
  echo "The Q Mush runner could not start. See $LOG_FILE." >&2
  exit 1
fi

echo "Q Mush runner installed and connected from this computer."
echo "Runner logs: $LOG_FILE"
`;
}
