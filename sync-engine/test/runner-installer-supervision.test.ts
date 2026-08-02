import { expect, test } from "vitest";
import { renderRunnerInstaller } from "../../sync-engine/runner-installer.ts";

const SERVER_ORIGIN = "https://q-mush.example";
const RUNNER_TOKEN = "qmr_runner-installer-supervision";

test("the installer launches a standalone runner supervisor", () => {
  const installer = renderRunnerInstaller(SERVER_ORIGIN, RUNNER_TOKEN);

  expect(installer).toContain(
    "SUPERVISOR_URL='https://q-mush.example/runner/supervisor'",
  );
  expect(installer).toContain(
    'curl -fsSL "$SUPERVISOR_URL?target=$RUNNER_TARGET" -o "$TEMP_SUPERVISOR"',
  );
  expect(installer).toContain(
    'nohup "$SUPERVISOR_FILE" "$RUNNER_FILE" "$CONFIG_FILE"',
  );
  expect(installer).not.toContain(
    'nohup "$RUNNER_FILE" --config "$CONFIG_FILE"',
  );
});
