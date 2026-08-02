import { connect } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { chromiumArguments } from "../page-fetch-chromium.ts";
import {
  MAXIMUM_RESPONSE_BYTES,
  type PageCapture,
  type PageResponse,
} from "../page-fetch-content.ts";
import {
  assertPublicPageUrl,
  PageFetchProxy,
  type PageAddressResolver,
} from "../page-fetch-process.ts";
import {
  createPageFetchRunnerTool,
  fetchRenderedPage,
  PAGE_FETCH_TOOL_NAME,
  type PageFetchDependencies,
} from "../page-fetch.ts";

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

async function proxyError(
  resolver: PageAddressResolver,
  target: string,
): Promise<Error> {
  const proxy = new PageFetchProxy(resolver);
  const port = await proxy.start();
  const client = connect({ host: "127.0.0.1", port });
  const proxyFailure = new Promise<Error>((resolve) => {
    const check = (): void => {
      if (proxy.failure === undefined) {
        setTimeout(check, 1);
      } else {
        resolve(proxy.failure);
      }
    };
    check();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write(`GET ${target} HTTP/1.1\r\nHost: example.com\r\n\r\n`);
    return await proxyFailure;
  } finally {
    client.destroy();
    await proxy.close();
  }
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
      truncated: { links: false, metadata: false, output: false, text: false },
    });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1_024);
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

    const proxyFailure = await proxyError(proxyResolver, "http://example.com/");
    expect(proxyFailure.message).toMatch(/ECONNREFUSED|ENETUNREACH/u);
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
