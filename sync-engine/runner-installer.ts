import { RUNNER_EXECUTABLE_PATH } from "../shared/routes.ts";
import { RUNNER_TARGETS } from "./runner-target.ts";

export function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderRunnerInstaller(
  serverOrigin: string,
  token: string,
): string {
  const origin = quoteShellValue(serverOrigin);
  const runnerUrl = quoteShellValue(
    new URL(RUNNER_EXECUTABLE_PATH, serverOrigin).toString(),
  );
  const setupToken = quoteShellValue(token);

  return `#!/bin/sh
set -eu

SERVER_ORIGIN=${origin}
RUNNER_TOKEN=${setupToken}
RUNNER_URL=${runnerUrl}
INSTALL_DIR="\${Q_MUSH_RUNNER_HOME:-$HOME/.q-mush/runner}"
RUNNER_FILE="$INSTALL_DIR/q-mush-runner"
LEGACY_RUNNER_FILE="$INSTALL_DIR/q-mush-runner.js"
CONFIG_FILE="$INSTALL_DIR/config"
PID_FILE="$INSTALL_DIR/runner.pid"
LOG_FILE="$INSTALL_DIR/runner.log"

if ! command -v curl >/dev/null 2>&1; then
  echo "Q Mush runner setup needs curl." >&2
  exit 1
fi

OPERATING_SYSTEM="$(uname -s)"
ARCHITECTURE="$(uname -m)"
LIBC="glibc"
if [ "$OPERATING_SYSTEM" = "Linux" ] && command -v ldd >/dev/null 2>&1; then
  LIBC_DESCRIPTION="$(ldd --version 2>&1 || true)"
  case "$LIBC_DESCRIPTION" in
    *musl*|*Musl*) LIBC="musl" ;;
  esac
fi

case "$OPERATING_SYSTEM:$ARCHITECTURE:$LIBC" in
  Darwin:arm64:*) RUNNER_TARGET=${RUNNER_TARGETS.darwinArm64} ;;
  Darwin:x86_64:*) RUNNER_TARGET=${RUNNER_TARGETS.darwinX64} ;;
  Linux:arm64:glibc|Linux:aarch64:glibc) RUNNER_TARGET=${RUNNER_TARGETS.linuxArm64} ;;
  Linux:arm64:musl|Linux:aarch64:musl) RUNNER_TARGET=${RUNNER_TARGETS.linuxArm64Musl} ;;
  Linux:x86_64:glibc|Linux:amd64:glibc) RUNNER_TARGET=${RUNNER_TARGETS.linuxX64} ;;
  Linux:x86_64:musl|Linux:amd64:musl) RUNNER_TARGET=${RUNNER_TARGETS.linuxX64Musl} ;;
  *)
    echo "Q Mush runners do not support $OPERATING_SYSTEM $ARCHITECTURE ($LIBC)." >&2
    exit 1
    ;;
esac

mkdir -p "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR"
TEMP_RUNNER="$RUNNER_FILE.tmp.$$"
trap 'rm -f "$TEMP_RUNNER"' EXIT HUP INT TERM
curl -fsSL "$RUNNER_URL?target=$RUNNER_TARGET" -o "$TEMP_RUNNER"
chmod 755 "$TEMP_RUNNER"
printf '%s\\n%s\\n' "$SERVER_ORIGIN" "$RUNNER_TOKEN" > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  RUNNING_COMMAND="$(ps -p "$OLD_PID" -o command= 2>/dev/null || true)"
  case "$RUNNING_COMMAND" in
    *"$RUNNER_FILE"*) kill "$OLD_PID" 2>/dev/null || true ;;
  esac
fi

mv "$TEMP_RUNNER" "$RUNNER_FILE"
rm -f "$LEGACY_RUNNER_FILE"
nohup "$RUNNER_FILE" --config "$CONFIG_FILE" >> "$LOG_FILE" 2>&1 &
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
