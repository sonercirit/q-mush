import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  createConnection,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import { parseRunnerUrl } from "./runner-url.ts";

interface PageAddressResolution {
  readonly address: unknown;
  readonly family: unknown;
}

interface PageAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type PageAddressResolver = (
  hostname: string,
) => Promise<readonly PageAddressResolution[]>;

function ipv4Number(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
      return undefined;
    }
    const byte = Number(part);
    if (byte > 255) {
      return undefined;
    }
    value = value * 256 + byte;
  }
  return value;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(value / blockSize) === Math.floor(base / blockSize);
}

function publicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === undefined) {
    return false;
  }
  const blocked: readonly (readonly [string, number])[] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, prefix]) => {
    const baseValue = ipv4Number(base);
    return baseValue !== undefined && inIpv4Range(value, baseValue, prefix);
  });
}

function ipv6Number(address: string): bigint | undefined {
  const percent = address.indexOf("%");
  const normalized = (
    percent < 0 ? address : address.slice(0, percent)
  ).toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const readGroups = (part: string): number[] | undefined => {
    if (part.length === 0) {
      return [];
    }
    const groups: number[] = [];
    for (const field of part.split(":")) {
      if (field.includes(".")) {
        const ipv4 = ipv4Number(field);
        if (ipv4 === undefined) {
          return undefined;
        }
        groups.push(Math.floor(ipv4 / 65_536), ipv4 % 65_536);
      } else if (!/^[\da-f]{1,4}$/u.test(field)) {
        return undefined;
      } else {
        groups.push(Number.parseInt(field, 16));
      }
    }
    return groups;
  };
  const left = readGroups(halves[0] ?? "");
  const right = readGroups(halves[1] ?? "");
  if (left === undefined || right === undefined) {
    return undefined;
  }
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) {
    return undefined;
  }
  const groups = [
    ...left,
    ...Array.from({ length: omitted }, () => 0),
    ...right,
  ];
  if (groups.length !== 8) {
    return undefined;
  }
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function inIpv6Range(value: bigint, base: bigint, prefix: number): boolean {
  return value >> BigInt(128 - prefix) === base >> BigInt(128 - prefix);
}

function embeddedIpv4(value: bigint): number | undefined {
  const prefix = value >> 32n;
  return prefix === 0n ||
    prefix === 0xffffn ||
    prefix === 0xffff0000n ||
    prefix === 0xffff00000000n ||
    prefix === 0x64ff9b000000000000000000n ||
    prefix === 0x64ff9b000100000000000000n
    ? Number(value & 0xffffffffn)
    : undefined;
}

function publicIpv6(address: string): boolean {
  const value = ipv6Number(address);
  if (value === undefined) {
    return false;
  }
  const ipv4 = embeddedIpv4(value);
  if (ipv4 !== undefined) {
    return publicIpv4(
      [24, 16, 8, 0].map((shift) => String((ipv4 >> shift) & 255)).join("."),
    );
  }
  const blocked: readonly (readonly [bigint, number])[] = [
    [0n, 128],
    [1n, 128],
    [0x0064ff9b000000000000000000000000n, 96],
    [0x0064ff9b000100000000000000000000n, 48],
    [0x01000000000000000000000000000000n, 64],
    [0x20010db8000000000000000000000000n, 32],
    [0xfc000000000000000000000000000000n, 7],
    [0xfe800000000000000000000000000000n, 10],
    [0xff000000000000000000000000000000n, 8],
  ];

  return !blocked.some(([base, prefix]) => inIpv6Range(value, base, prefix));
}

function pageAddressIsPublic(address: string): boolean {
  const normalized =
    address.startsWith("[") && address.endsWith("]")
      ? address.slice(1, -1)
      : address;
  const family = isIP(normalized);
  return family === 4
    ? publicIpv4(normalized)
    : family === 6 && publicIpv6(normalized);
}

function unsafeDestination(): Error {
  return new Error("Page URL resolves to an unsafe network destination");
}

function hostnameResolutionFailure(): Error {
  return new Error("Page URL hostname could not be resolved");
}

function assertPublicPageAddress(address: string): void {
  if (!pageAddressIsPublic(address)) {
    throw unsafeDestination();
  }
}

export const defaultPageAddressResolver: PageAddressResolver = async (
  hostname,
) => {
  const values = await lookup(hostname, { all: true, verbatim: true });
  return values;
};

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

async function publicPageAddresses(
  url: URL,
  resolveAddress: PageAddressResolver = defaultPageAddressResolver,
): Promise<readonly PageAddress[]> {
  const hostname = normalizedHostname(url);
  if (hostname.length === 0 || hostname.toLowerCase() === "localhost") {
    throw unsafeDestination();
  }
  if (isIP(hostname) !== 0) {
    assertPublicPageAddress(hostname);
    return [{ address: hostname, family: isIP(hostname) === 4 ? 4 : 6 }];
  }
  let resolved: readonly PageAddressResolution[];
  try {
    resolved = await resolveAddress(hostname);
  } catch {
    throw hostnameResolutionFailure();
  }
  const addresses: PageAddress[] = [];
  for (const value of resolved) {
    if (typeof value.address !== "string") {
      continue;
    }
    const family = isIP(value.address);
    if (family === 4 || family === 6) {
      addresses.push({ address: value.address, family });
    }
  }
  if (addresses.some(({ address }) => !pageAddressIsPublic(address))) {
    throw unsafeDestination();
  }
  if (addresses.length === 0) {
    throw hostnameResolutionFailure();
  }
  return addresses;
}

export async function assertPublicPageUrl(
  url: URL,
  resolveAddress: PageAddressResolver = defaultPageAddressResolver,
): Promise<void> {
  await publicPageAddresses(url, resolveAddress);
}

const MAXIMUM_PROXY_HEADER_BYTES = 64 * 1_024;
const PROXY_FAILURE_RESPONSE = Buffer.from(
  "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
);

function proxyUrl(value: string): URL {
  const url = parseRunnerUrl(
    value,
    "Browser requested an invalid network destination",
  );
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Browser requested an unsafe network destination");
  }
  return url;
}

function connectUrl(authority: string): URL {
  const url = proxyUrl(`https://${authority}/`);
  if (url.port.length === 0) {
    url.port = "443";
  }
  return url;
}

function targetPort(url: URL): number {
  const port =
    url.port.length > 0
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Browser requested an invalid network port");
  }
  return port;
}

function forwardedRequest(header: Buffer, url: URL): Buffer {
  const lines = header.toString("latin1").slice(0, -4).split("\r\n");
  const firstLine = lines.shift();
  if (firstLine === undefined) {
    throw new Error("Browser sent an invalid proxy request");
  }
  const fields = firstLine.split(" ");
  const method = fields[0];
  const version = fields[2];
  if (method === undefined || version === undefined) {
    throw new Error("Browser sent an invalid proxy request");
  }
  const headers = lines.filter(
    (line) =>
      !/^proxy-(?:authorization|connection):/iu.test(line) &&
      !/^connection:/iu.test(line),
  );
  headers.push("Connection: close");
  const path = `${url.pathname}${url.search}`;
  return Buffer.from(
    `${[
      `${method} ${path.length === 0 ? "/" : path} ${version}`,
      ...headers,
    ].join("\r\n")}\r\n\r\n`,
    "latin1",
  );
}

const processProxySocket = (proxy: PageFetchProxy, socket: Socket): void => {
  proxy.accept(socket);
};

export class PageFetchProxy {
  readonly #resolveAddress: PageAddressResolver;
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  failure: Error | undefined;

  constructor(
    resolveAddress: PageAddressResolver = defaultPageAddressResolver,
  ) {
    this.#resolveAddress = resolveAddress;
  }

  async start(): Promise<number> {
    if (this.#server !== undefined) {
      throw new Error("Page fetch proxy is already running");
    }
    const server = createServer((socket) => {
      processProxySocket(this, socket);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      await this.close();
      throw new Error("Page fetch proxy did not expose a local port");
    }
    return address.port;
  }

  accept(client: Socket): void {
    this.#sockets.add(client);
    client.once("close", () => {
      this.#sockets.delete(client);
    });
    let buffered = Buffer.alloc(0);
    const receive = (chunk: string | Buffer): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      buffered = Buffer.concat([buffered, bytes]);
      if (buffered.byteLength > MAXIMUM_PROXY_HEADER_BYTES) {
        this.#reject(
          client,
          new Error("Browser proxy headers exceeded the limit"),
        );
        return;
      }
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      client.removeAllListeners("data");
      client.pause();
      void this.#forward(client, buffered, headerEnd + 4).catch(
        (error: unknown) => {
          this.#reject(
            client,
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
    };
    client.on("data", receive);
    client.once("error", () => {
      client.destroy();
    });
  }

  async #forward(
    client: Socket,
    buffered: Buffer,
    bodyStart: number,
  ): Promise<void> {
    const header = buffered.subarray(0, bodyStart);
    const body = buffered.subarray(bodyStart);
    const firstLine = header.toString("latin1", 0, header.indexOf("\r\n"));
    const [method, target] = firstLine.split(" ");
    if (method === undefined || target === undefined) {
      throw new Error("Browser sent an invalid proxy request");
    }
    const isConnect = method.toUpperCase() === "CONNECT";
    const url = isConnect ? connectUrl(target) : proxyUrl(target);
    const addresses = await publicPageAddresses(url, this.#resolveAddress);
    const address = addresses[0];
    if (address === undefined) {
      throw hostnameResolutionFailure();
    }
    const upstream = createConnection({
      family: address.family,
      host: address.address,
      port: targetPort(url),
    });
    this.#sockets.add(upstream);
    upstream.once("close", () => {
      this.#sockets.delete(upstream);
    });
    upstream.once("error", (error) => {
      this.#reject(client, error);
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("connect", resolve);
      upstream.once("error", reject);
    });
    if (isConnect) {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    } else {
      upstream.write(forwardedRequest(header, url));
    }
    if (body.byteLength > 0) {
      upstream.write(body);
    }
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  }

  #reject(client: Socket, error: Error): void {
    this.failure ??= error;
    for (const socket of this.#sockets) {
      if (socket !== client) {
        socket.destroy();
      }
    }
    if (!client.destroyed) {
      client.end(PROXY_FAILURE_RESPONSE);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

function trackedChildProcessIds(parentId: number): readonly number[] {
  if (process.platform !== "linux") {
    return [];
  }
  const descendants = new Set<number>();
  const visit = (id: number): void => {
    let value: string;
    try {
      value = readFileSync(
        `/proc/${String(id)}/task/${String(id)}/children`,
        "utf8",
      );
    } catch {
      return;
    }
    for (const field of value.trim().split(/\s+/u)) {
      const childId = Number(field);
      if (
        Number.isSafeInteger(childId) &&
        childId > 0 &&
        !descendants.has(childId)
      ) {
        descendants.add(childId);
        visit(childId);
      }
    }
  };
  visit(parentId);
  return [...descendants];
}

function stopTrackedChildren(
  ids: readonly number[],
  signal: NodeJS.Signals,
): void {
  for (const id of ids) {
    try {
      process.kill(id, signal);
    } catch {
      // The tracked browser child has already stopped.
    }
  }
}

async function removeProfileAttempts(
  path: string,
  attempts: number,
  afterFailure?: () => void,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { force: true, recursive: true });
      return;
    } catch (error) {
      lastError = error;
      afterFailure?.();
      await Bun.sleep(50);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not remove the temporary Chromium profile");
}

function signalChromium(
  child: Bun.ReadableSubprocess,
  signal: NodeJS.Signals,
): void {
  if (process.platform === "win32") {
    if (child.exitCode === null) {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (child.exitCode === null) {
      child.kill(signal);
    }
  }
}

export async function stopChromium(
  child: Bun.ReadableSubprocess,
  profilePath?: string,
): Promise<void> {
  const children = trackedChildProcessIds(child.pid);
  signalChromium(child, "SIGTERM");
  stopTrackedChildren(children, "SIGTERM");
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(1_000).then(() => false),
  ]);
  if (!exited) {
    signalChromium(child, "SIGKILL");
    stopTrackedChildren(children, "SIGKILL");
    await child.exited;
  }
  if (profilePath !== undefined) {
    await removeProfileAttempts(profilePath, 20, () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
  }
}

export async function removeChromiumProfile(path: string): Promise<void> {
  await removeProfileAttempts(path, 5);
}
