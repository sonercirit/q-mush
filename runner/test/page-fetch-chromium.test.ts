import { describe, expect, test, vi } from "vitest";
import {
  assertChromiumExecutableAccessible,
  chromiumChildIdentity,
  createPasswdReader,
} from "../page-fetch-chromium.ts";

const EXPECTED_ERROR =
  "Chromium needs the unprivileged nobody account when the Q Mush runner is running as root";
const PASSWD = [
  "root:x:0:0:root:/root:/bin/sh",
  "nobody:x:65534:65534:Nobody:/:/usr/bin/nologin",
].join("\n");

function simulatedRootIdentity(passwd: string | Promise<string> = PASSWD) {
  return chromiumChildIdentity({
    effectiveUserId: () => 0,
    platform: "linux",
    readPasswd: () => Promise.resolve(passwd),
  });
}

describe("Chromium child identity", () => {
  test("inherits the runner identity unless Linux is running as root", async () => {
    const readPasswd = vi.fn(() => Promise.resolve(PASSWD));

    await expect(
      chromiumChildIdentity({
        effectiveUserId: () => 1_000,
        platform: "linux",
        readPasswd,
      }),
    ).resolves.toBeUndefined();
    await expect(
      chromiumChildIdentity({
        effectiveUserId: () => 0,
        platform: "darwin",
        readPasswd,
      }),
    ).resolves.toBeUndefined();
    expect(readPasswd).not.toHaveBeenCalled();
  });

  test("drops a root Linux runner to the nobody account", async () => {
    await expect(simulatedRootIdentity()).resolves.toEqual({
      gid: 65_534,
      uid: 65_534,
    });
  });

  test.each([
    ["a missing account", "root:x:0:0:root:/root:/bin/sh"],
    ["a root account", "nobody:x:0:0:Nobody:/:/usr/bin/nologin"],
    ["a malformed account", "nobody:x:not-a-uid:65534:Nobody:/:/bin/false"],
  ])("fails closed for %s", async (_description, passwd) => {
    await expect(simulatedRootIdentity(passwd)).rejects.toThrow(EXPECTED_ERROR);
  });

  test("fails closed when the account database cannot be read", async () => {
    await expect(
      simulatedRootIdentity(Promise.reject(new Error("read failed"))),
    ).rejects.toThrow(EXPECTED_ERROR);
  });

  test("retries failed passwd reads and caches only success", async () => {
    const readPasswdFile = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValue(PASSWD);
    const readPasswd = createPasswdReader(readPasswdFile);

    await expect(readPasswd()).rejects.toThrow("transient read failure");
    await expect(readPasswd()).resolves.toBe(PASSWD);
    await expect(readPasswd()).resolves.toBe(PASSWD);
    expect(readPasswdFile).toHaveBeenCalledTimes(2);
  });

  test("fails clearly when nobody cannot traverse the executable path", async () => {
    const statPath = vi.fn((path: string) =>
      Promise.resolve({
        gid: 0,
        mode: path === "/opt/private" ? 0o700 : 0o755,
        uid: 0,
      }),
    );

    await expect(
      assertChromiumExecutableAccessible(
        "/opt/private/chromium",
        { gid: 65_534, uid: 65_534 },
        { statPath },
      ),
    ).rejects.toThrow(
      "not stat-accessible for traversal and executable reading by the unprivileged nobody account",
    );
    expect(statPath).toHaveBeenCalledWith("/opt/private");
  });

  test("requires read and execute bits on the Chromium executable", async () => {
    const statPath = vi.fn((path: string) => {
      const mode = path.endsWith("chromium") ? 0o711 : 0o755;
      return Promise.resolve({ gid: 0, mode, uid: 0 });
    });
    const accessibility = assertChromiumExecutableAccessible(
      "/usr/bin/chromium",
      { gid: 65_534, uid: 65_534 },
      { statPath },
    );
    await expect(accessibility).rejects.toThrow("executable reading");
  });
});
