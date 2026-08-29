import { connect, Socket } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { chromiumArguments, prepareChromium } from "../page-fetch-chromium.ts";
import {
  MAXIMUM_RESPONSE_BYTES,
  type PageCapture,
  type PageResponse,
} from "../page-fetch-content.ts";
import {
  assertPublicPageUrl,
  createPageFetchProxy,
  type PageAddressResolver,
  type UpstreamConnector,
} from "../page-fetch-process.ts";
import {
  createChromiumProfile,
  createPageFetchRunnerTool,
  fetchRenderedPage,
  PAGE_FETCH_TOOL_NAME,
  spawnChromium,
  type PageFetchDependencies,
} from "../page-fetch.ts";

type PageFetchProxy = ReturnType<typeof createPageFetchProxy>;

type PageRenderer = NonNullable<PageFetchDependencies["render"]>;

const PUBLIC_ADDRESS = "93.184.216.34";
const PUBLIC_IPV6_ADDRESS = "2606:2800:220:1:248:1893:25c8:1946";
const publicResolver = () =>
  Promise.resolve([{ address: PUBLIC_ADDRESS, family: 4 as const }]);

const CAPTURE: PageCapture = {
  links: [{ text: "Rendered link", url: "https://example.com/rendered" }],
  metadata: {
    description: "Rendered metadata",
    openGraph: { type: "article" },
  },
  text: "JavaScript rendered text",
  title: "Rendered title",
  truncated: { links: false, metadata: false, text: false },
};

const RESPONSE: PageResponse = {
  charset: "utf-8",
  contentLength: 512,
  contentType: "text/html",
  finalUrl: "https://example.com/final",
  status: 200,
};

function evaluatedCapture(capture: PageCapture = CAPTURE): unknown {
  return { result: { value: capture } };
}

function dependencies(renderer: PageRenderer): PageFetchDependencies {
  return { render: renderer, resolveAddress: publicResolver };
}

function documentedRenderer(render: PageRenderer): PageRenderer {
  return async (request) => {
    await documentRequest(request);
    return await render(request);
  };
}

function acceptedResponse(
  request: Parameters<PageRenderer>[0],
  response: PageResponse,
): void {
  request.policy.response(response);
}

const successfulRenderer: PageRenderer = documentedRenderer((request) => {
  acceptedResponse(request, RESPONSE);
  request.policy.bytes(RESPONSE.contentLength ?? 0);
  return Promise.resolve({ evaluated: evaluatedCapture(), response: RESPONSE });
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected operation to reject");
}

async function withProxyClient<Result>(
  resolver: PageAddressResolver,
  connectUpstream: UpstreamConnector | undefined,
  request: string,
  run: (proxy: PageFetchProxy) => Promise<Result>,
): Promise<Result> {
  const proxy = createPageFetchProxy(resolver, connectUpstream);
  const port = await proxy.start();
  const client = connect({ host: "127.0.0.1", port });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write(request);
    return await run(proxy);
  } finally {
    client.destroy();
    await proxy.close();
  }
}

function proxyError(
  resolver: PageAddressResolver,
  target: string,
  connectUpstream?: UpstreamConnector,
): Promise<Error> {
  return withProxyClient(
    resolver,
    connectUpstream,
    `GET ${target} HTTP/1.1\r\nHost: example.com\r\n\r\n`,
    (proxy) =>
      new Promise<Error>((resolve) => {
        const check = (): void => {
          if (proxy.failure === undefined) {
            setTimeout(check, 1);
          } else {
            resolve(proxy.failure);
          }
        };
        check();
      }),
  );
}

async function fetchError(
  renderer: PageRenderer,
  url = "https://example.com/large",
): Promise<Error> {
  return rejection(
    fetchRenderedPage({ url }, undefined, dependencies(renderer)),
  );
}

async function documentRequest(
  request: Parameters<PageRenderer>[0],
): Promise<void> {
  await request.policy.document(request.url.toString());
}

describe("default Chromium renderer setup", () => {
  test("owns root profiles under /tmp and cleans up ownership failures", async () => {
    const createTemporaryDirectory = vi.fn(() =>
      Promise.resolve("/tmp/profile"),
    );
    const chownPath = vi.fn(() => Promise.resolve());
    const identity = { gid: 65_534, uid: 65_534 };
    const profileDependencies = { chownPath, createTemporaryDirectory };
    await expect(
      createChromiumProfile(identity, profileDependencies),
    ).resolves.toBe("/tmp/profile");
    expect(createTemporaryDirectory).toHaveBeenCalledWith(
      "/tmp/q-mush-page-fetch-",
    );
    expect(chownPath).toHaveBeenCalledWith("/tmp/profile", 65_534, 65_534);

    const removeProfile = vi.fn(() => Promise.resolve());
    await expect(
      createChromiumProfile(identity, {
        chownPath: () => Promise.reject(new Error("denied")),
        createTemporaryDirectory,
        removeProfile,
      }),
    ).rejects.toThrow("Could not prepare an unprivileged Chromium profile");
    expect(removeProfile).toHaveBeenCalledWith("/tmp/profile");
  });
  test("passes the identity through the Chromium spawn options", () => {
    let options: unknown;
    const spawn = (...arguments_: Parameters<typeof Bun.spawn>) => {
      options = arguments_[1];
      return Bun.spawn(["true"], { stderr: "pipe", stdout: "pipe" });
    };
    const child = spawnChromium(
      "/chromium",
      "/tmp/profile",
      1234,
      { gid: 2345, uid: 1234 },
      spawn,
    );
    expect(options).toMatchObject({ gid: 2345, uid: 1234 });
    child.kill();
  });
  test("sequences identity, accessibility, profile, and spawn identity", async () => {
    const calls: string[] = [];
    const identity = { gid: 65_534, uid: 65_534 };
    const setup = await prepareChromium(
      "/chromium",
      (receivedIdentity) => {
        calls.push(`profile:${String(receivedIdentity === identity)}`);
        return Promise.resolve("/tmp/profile");
      },
      {
        resolveIdentity: () => {
          calls.push("identity");
          return Promise.resolve(identity);
        },
        assertAccessible: (_path, receivedIdentity) => {
          calls.push(`accessible:${String(receivedIdentity === identity)}`);
          return Promise.resolve();
        },
      },
    );
    let spawnOptions: Parameters<typeof Bun.spawn>[1] | undefined;
    const setupProfile = setup.profilePath;
    const child = spawnChromium(
      "/chromium",
      setupProfile,
      1234,
      setup.identity,
      (command, options) => {
        void command;
        spawnOptions = options;
        const executable = ["true"];
        return Bun.spawn(executable, { stderr: "pipe", stdout: "pipe" });
      },
    );

    expect(calls).toEqual(["identity", "accessible:true", "profile:true"]);
    expect(spawnOptions).toMatchObject(identity);
    child.kill();
  });
});

describe("page_fetch", () => {
  test("returns bounded browser-rendered content through its runner registration surface", async () => {
    let expression = "";
    const renderer: PageRenderer = (request) => {
      expression = request.captureExpression;
      return successfulRenderer(request);
    };
    const tool = createPageFetchRunnerTool(dependencies(renderer));
    const output = await tool(
      "/workspace/is-resolved-by-runner-tools",
      { url: "https://example.com/start" },
      undefined,
    );
    const result: unknown = JSON.parse(output);

    expect(PAGE_FETCH_TOOL_NAME).toBe("page_fetch");
    expect(expression).toContain("document.title");
    expect(expression).toContain(
      'querySelectorAll("script, style, template, noscript")',
    );
    expect(result).toMatchObject({
      charset: "utf-8",
      contentType: "text/html",
      finalUrl: "https://example.com/final",
      links: CAPTURE.links,
      metadata: CAPTURE.metadata,
      status: 200,
      text: CAPTURE.text,
      title: CAPTURE.title,
      truncated: { links: false, metadata: false, text: false },
    });
  });

  test("times out and aborts the render without sleeping", async () => {
    vi.useFakeTimers();
    let renderSignal: AbortSignal | undefined;
    const renderer: PageRenderer = (request) => {
      renderSignal = request.signal;
      return new Promise(() => undefined);
    };

    try {
      const pending = fetchRenderedPage(
        { timeout: 1, url: "https://example.com" },
        undefined,
        dependencies(renderer),
      );
      const assertion = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(renderSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stops an oversized response at the byte boundary", async () => {
    const renderer = documentedRenderer((request) => {
      request.policy.response({
        ...RESPONSE,
        contentLength: MAXIMUM_RESPONSE_BYTES + 1,
      });
      throw new Error("response policy unexpectedly continued");
    });

    const error = await fetchError(renderer);
    expect(error.message).toContain("byte limit");
  });

  test("caps browser redirects before the eleventh redirect is followed", async () => {
    const renderer = documentedRenderer(async (request) => {
      for (let redirect = 1; redirect <= 11; redirect += 1) {
        const source =
          redirect === 1
            ? request.url.toString()
            : `https://example.com/redirect-${String(redirect - 1)}`;
        const target = `https://example.com/redirect-${String(redirect)}`;
        await request.policy.redirect(target, source);
        await request.policy.document(target);
      }
      throw new Error("redirect policy unexpectedly continued");
    });

    const error = await fetchError(renderer, "https://example.com/start");
    expect(error.message).toContain("10 redirect limit");
  });

  test("rejects non-HTML and HTTP error responses", async () => {
    for (const [response, expected] of [
      [{ ...RESPONSE, contentType: "application/pdf" }, "did not return HTML"],
      [{ ...RESPONSE, status: 503 }, "HTTP 503"],
    ] as const) {
      const renderer = documentedRenderer((request) => {
        acceptedResponse(request, response);
        return Promise.resolve({ evaluated: evaluatedCapture(), response });
      });
      const error = await fetchError(renderer, "https://example.com/error");
      expect(error.message).toContain(expected);
    }
  });

  test("accepts a rendered response after document URL validation", async () => {
    const renderer: PageRenderer = documentedRenderer((request) => {
      request.policy.response(RESPONSE);
      return Promise.resolve({
        evaluated: evaluatedCapture(),
        response: RESPONSE,
      });
    });

    await expect(
      fetchRenderedPage(
        { url: "https://example.com/" },
        undefined,
        dependencies(renderer),
      ),
    ).resolves.toContain("Rendered title");
  });

  test("normalizes divergent DNS family metadata at page and proxy boundaries", async () => {
    const pageResolver: PageAddressResolver = () =>
      Promise.resolve([
        { address: PUBLIC_ADDRESS, family: "IPv4" },
        { address: PUBLIC_IPV6_ADDRESS, family: 0 },
      ]);
    const proxyResolver: PageAddressResolver = () =>
      Promise.resolve([{ address: "2001:4860:ffff::1", family: 0 }]);

    await expect(
      assertPublicPageUrl(new URL("https://example.com/"), pageResolver),
    ).resolves.toBeUndefined();

    // The injected connector observes the normalized family and fails fast
    // without real network I/O (a live SYN to this address hangs on hosts
    // whose IPv6 route silently drops packets).
    let connected: unknown;
    const proxyFailure = await proxyError(
      proxyResolver,
      "http://example.com/",
      (options) => {
        connected = options;
        const socket = new Socket();
        queueMicrotask(() => {
          socket.destroy(new Error("connect ECONNREFUSED (stubbed)"));
        });
        return socket;
      },
    );
    expect(connected).toMatchObject({ family: 6, host: "2001:4860:ffff::1" });
    expect(proxyFailure.message).toContain("ECONNREFUSED");
  });

  test("bounds a hanging upstream connect instead of stalling the tunnel", async () => {
    // Node arms the connect timeout only when the options carry one;
    // Socket timers are internal, so the stub emits a timeout instead of
    // sleeping through one. Emitting unconditionally keeps the failure
    // fast and attributed here even if the source stops passing a bound.
    let configuredTimeout: number | undefined;
    const hanging = await proxyError(
      publicResolver,
      "http://example.com/",
      (options) => {
        // Never connects: emulates a SYN silently dropped upstream.
        configuredTimeout = options.timeout;
        const socket = new Socket();
        queueMicrotask(() => socket.emit("timeout"));
        return socket;
      },
    );
    // The exact bound is the proxy's business; the behavior under test is
    // that a positive bound exists and surfaces a visible failure.
    expect(configuredTimeout ?? 0).toBeGreaterThan(0);
    expect(hanging.message).toContain("timed out");
  });

  test("disarms the connect bound once the tunnel is established", async () => {
    let upstream: Socket | undefined;
    await withProxyClient(
      publicResolver,
      (options) => {
        const socket = new Socket();
        // Applying the handed bound the way node does keeps the disarm
        // assertion non-vacuous: a bare Socket already reports timeout 0.
        socket.setTimeout(options.timeout ?? 0);
        upstream = socket;
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
      // CONNECT keeps the exchange client-side only; the non-CONNECT
      // branch would call forwardedRequest and exercise unrelated
      // request-line rewriting against the stub.
      "CONNECT example.com:443 HTTP/1.1\r\n\r\n",
      async (proxy) => {
        // A silent origin past the bound must not kill the tunnel: the
        // proxy disarms the connect timer and drops its destructive
        // handler once the connection is established.
        await vi.waitFor(() => {
          expect(upstream?.timeout).toBe(0);
        });
        expect(upstream?.listenerCount("timeout")).toBe(0);
        // Even a late timer firing must be a no-op on the tunnel.
        upstream?.emit("timeout");
        expect(upstream?.destroyed).toBe(false);
        expect(proxy.failure).toBeUndefined();
      },
    );
  });

  test("distinguishes resolution failures from unsafe DNS answers", async () => {
    const unresolved = await rejection(
      assertPublicPageUrl(new URL("https://missing.example/"), () =>
        Promise.resolve([]),
      ),
    );
    const failed = await rejection(
      assertPublicPageUrl(new URL("https://failed.example/"), () =>
        Promise.reject(new Error("DNS unavailable")),
      ),
    );
    const unsafe = await rejection(
      assertPublicPageUrl(new URL("https://private.example/"), () =>
        Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      ),
    );

    expect(unresolved.message).toContain("could not be resolved");
    expect(unresolved.message).not.toContain("unsafe network destination");
    expect(failed.message).toContain("could not be resolved");
    expect(failed.message).not.toContain("unsafe network destination");
    expect(unsafe.message).toContain("unsafe network destination");
  });

  test("guards URL, DNS, redirect, and browser process capabilities", async () => {
    let renders = 0;
    const unusedRenderer: PageRenderer = () => {
      renders += 1;
      return Promise.reject(new Error("renderer should not start"));
    };
    const publicDependencies = dependencies(unusedRenderer);

    for (const url of [
      "file:///etc/passwd",
      "https://user:secret@example.com/",
      "https://example.com/#secret",
      "http://localhost/",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[fd00:ec2::254]/latest/meta-data/",
    ]) {
      const error = await rejection(
        fetchRenderedPage({ url }, undefined, publicDependencies),
      );
      expect(error.message).toMatch(
        /HTTP or HTTPS|credentials|fragment|unsafe network destination/u,
      );
    }

    const mixedDnsError = await rejection(
      fetchRenderedPage({ url: "https://rebound.example" }, undefined, {
        render: unusedRenderer,
        resolveAddress: () =>
          Promise.resolve([
            { address: PUBLIC_ADDRESS, family: 4 as const },
            { address: "127.0.0.1", family: 4 as const },
          ]),
      }),
    );
    expect(mixedDnsError.message).toContain("unsafe network destination");
    expect(renders).toBe(0);

    const redirectError = await fetchError(
      documentedRenderer(async (request) => {
        await request.policy.redirect(
          "http://127.0.0.1/private",
          request.url.toString(),
        );
        throw new Error("redirect policy unexpectedly continued");
      }),
      "https://example.com",
    );
    expect(redirectError.message).toContain("unsafe network destination");

    const arguments_ = chromiumArguments("/chromium", "/isolated", 8_080);
    expect(arguments_).toEqual(
      expect.arrayContaining([
        "--disable-background-networking",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--proxy-server=http://127.0.0.1:8080",
        "--proxy-bypass-list=<-loopback>",
      ]),
    );
    expect(arguments_).not.toContain("--no-sandbox");
  });
});
