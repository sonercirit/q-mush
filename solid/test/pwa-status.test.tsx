import { expect, test } from "vitest";
import { PwaStatus, type PwaStatusProps } from "../pwa-status.tsx";
import { renderSolidToString } from "./render-solid.tsx";

const idleStatus: PwaStatusProps = {
  installed: false,
  installAvailable: false,
  iosInstallAvailable: false,
  offline: false,
  onInstall: () => undefined,
  onReload: () => undefined,
  updateAvailable: false,
};

function renderStatus(overrides: Partial<PwaStatusProps>): string {
  return renderSolidToString(() => (
    <PwaStatus {...idleStatus} {...overrides} />
  ));
}

test("renders an accessible offline reconnect message without account data", () => {
  const html = renderStatus({ offline: true });

  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("You’re offline");
  expect(html).toContain("Reconnect to verify your session");
  expect(html).not.toContain("transcript");
  expect(html).not.toContain("Signed in as");
});

test("offers update, native install, and iOS instructions when applicable", () => {
  const update = renderStatus({
    installAvailable: true,
    updateAvailable: true,
  });
  const ios = renderStatus({ iosInstallAvailable: true });

  expect(update).toContain("Update available");
  expect(update).toContain(">Reload</button>");
  expect(update).toContain(">Install app</button>");
  expect(ios).toContain("Add to Home Screen");
});
