import { constants, existsSync, realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const CHROMIUM_ENVIRONMENT_VARIABLE = "Q_MUSH_CHROMIUM_EXECUTABLE";

const COMMON_CHROMIUM_EXECUTABLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  join(
    homedir(),
    "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ),
  join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
] as const;
const CHROMIUM_EXECUTABLE_NAMES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "chrome",
] as const;

export interface ChromiumDiscoveryOptions {
  readonly executablePath?: string | undefined;
}

interface ChromiumIdentityDependencies {
  readonly effectiveUserId?: (() => number | undefined) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly readPasswd?: (() => Promise<string>) | undefined;
}

type ChromiumChildIdentity = Readonly<{ gid: number; uid: number }>;

const ROOT_USER_ID = 0;
const MAXIMUM_POSIX_ID = 0xffff_fffe;
const NOBODY_ACCOUNT = "nobody";
const NOBODY_REQUIRED_MESSAGE =
  "Chromium needs the unprivileged nobody account when the Q Mush runner is running as root";

function positivePosixId(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return undefined;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) && id > ROOT_USER_ID && id <= MAXIMUM_POSIX_ID
    ? id
    : undefined;
}

function nobodyIdentity(passwd: string): ChromiumChildIdentity | undefined {
  for (const line of passwd.split(/\r?\n/u)) {
    const fields = line.split(":");
    if (fields[0] !== NOBODY_ACCOUNT) {
      continue;
    }
    const uid = positivePosixId(fields[2]);
    const gid = positivePosixId(fields[3]);
    return uid === undefined || gid === undefined ? undefined : { gid, uid };
  }
  return undefined;
}

function nobodyRequired(cause?: unknown): Error {
  return new Error(NOBODY_REQUIRED_MESSAGE, { cause });
}

export async function chromiumChildIdentity(
  dependencies: ChromiumIdentityDependencies = {},
): Promise<ChromiumChildIdentity | undefined> {
  const platform = dependencies.platform ?? process.platform;
  const effectiveUserId = (
    dependencies.effectiveUserId ?? (() => process.geteuid?.())
  )();
  if (platform !== "linux" || effectiveUserId !== ROOT_USER_ID) {
    return undefined;
  }

  let passwd: string;
  try {
    passwd = await (
      dependencies.readPasswd ?? (() => readFile("/etc/passwd", "utf8"))
    )();
  } catch (error) {
    throw nobodyRequired(error);
  }
  const identity = nobodyIdentity(passwd);
  if (identity === undefined) {
    throw nobodyRequired();
  }
  return identity;
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableOnPath(name: string): string | undefined {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = resolve(directory, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function discoverChromiumExecutable(
  options: ChromiumDiscoveryOptions = {},
): Promise<string> {
  const configured = (
    options.executablePath ?? process.env[CHROMIUM_ENVIRONMENT_VARIABLE]
  )?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (await executableExists(configured)) {
      return realpathSync(configured);
    }
    throw new Error(
      `Chromium is unavailable at the configured path (${configured}). Set ${CHROMIUM_ENVIRONMENT_VARIABLE} to an executable Chromium or Chrome path.`,
    );
  }

  for (const path of COMMON_CHROMIUM_EXECUTABLES) {
    if (await executableExists(path)) {
      return realpathSync(path);
    }
  }
  for (const name of CHROMIUM_EXECUTABLE_NAMES) {
    const path = executableOnPath(name);
    if (path !== undefined && (await executableExists(path))) {
      return realpathSync(path);
    }
  }

  throw new Error(
    `Chromium is unavailable. Install Chromium or Chrome, or set ${CHROMIUM_ENVIRONMENT_VARIABLE} to its executable path.`,
  );
}

export function chromiumArguments(
  executablePath: string,
  profilePath: string,
  proxyPort?: number,
): readonly string[] {
  return [
    executablePath,
    "--headless=new",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-client-side-phishing-detection",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-domain-reliability",
    "--disable-extensions",
    "--disable-features=OptimizationHints,MediaRouter,AutofillServerCommunication,PasswordLeakDetection",
    "--disable-quic",
    "--disable-reporting",
    "--disable-sync",
    "--disable-translate",
    "--dns-prefetch-disable",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--metrics-recording-only",
    "--no-pings",
    "--password-store=basic",
    "--use-mock-keychain",
    ...(proxyPort === undefined
      ? []
      : [
          `--proxy-server=http://127.0.0.1:${String(proxyPort)}`,
          "--proxy-bypass-list=<-loopback>",
        ]),
    "about:blank",
  ];
}
