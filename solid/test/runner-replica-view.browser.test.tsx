import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import { RunnerReplicaView } from "../runner-replica-view.tsx";
import "../styles.css";

const digest = "a".repeat(64);

function runnerViewFixture(): {
  readonly dispose: () => void;
  readonly meta: HTMLMetaElement;
  readonly root: HTMLDivElement;
} {
  const meta = document.createElement("meta");
  meta.name = "q-mush-host";
  meta.content = "runner";
  document.head.append(meta);
  const root = document.createElement("div");
  document.body.append(root);
  return { dispose: render(() => <RunnerReplicaView />, root), meta, root };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function completeView(records: readonly unknown[]): Response {
  return Response.json({ complete: true, records });
}

function sessionViewResponse(
  records: readonly { readonly id: string; readonly title: string }[],
): Promise<Response> {
  return Promise.resolve(completeView(records));
}

function requestUrl(input: RequestInfo | URL): URL {
  const value =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  return new URL(value, location.origin);
}

function abortableResponse(
  init: RequestInit | undefined,
  onAbort: () => void,
  onResolve?: (resolve: (response: Response) => void) => void,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    onResolve?.(resolve);
    init?.signal?.addEventListener("abort", () => {
      onAbort();
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

function mockRunnerFetch(
  readView: (url: URL, init?: RequestInit) => Promise<Response>,
): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = requestUrl(input);
    return url.pathname === "/api/local/status"
      ? Promise.resolve(Response.json({ complete: true }))
      : readView(url, init);
  });
}

function removeRunnerViewFixture(
  fixture: ReturnType<typeof runnerViewFixture>,
): void {
  fixture.dispose();
  fixture.root.remove();
  fixture.meta.remove();
}

async function expectRequestCount(
  readCount: () => number,
  expected: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(readCount()).toBe(expected);
  });
}

let mountedFixture: ReturnType<typeof runnerViewFixture> | undefined;

function mountRunnerView(): HTMLDivElement {
  mountedFixture = runnerViewFixture();
  return mountedFixture.root;
}

function disposeRunnerView(): void {
  if (mountedFixture !== undefined) removeRunnerViewFixture(mountedFixture);
  mountedFixture = undefined;
}

afterEach(() => {
  disposeRunnerView();
});

async function waitForText(root: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!root.textContent.includes(text)) throw new Error(`Missing ${text}`);
    },
    { timeout: 2_500 },
  );
}

test("real Chromium reads a complete runner replica and renders attachments read-only", async () => {
  let statusRequests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/local/status") {
      statusRequests += 1;
      return Promise.resolve(
        Response.json({
          complete: true,
          retry: {
            elapsedMilliseconds: statusRequests === 1 ? 123 : 456,
            previousRevision: "old",
            restartCount: statusRequests,
            revision: statusRequests === 1 ? "new" : "newer",
          },
        }),
      );
    }
    const entity = url.searchParams.get("entity");
    const records =
      entity === "agent_sessions"
        ? [{ id: "other-executor", title: "Session from runner B" }]
        : [
            {
              content: "Offline transcript",
              id: "message-1",
              images: JSON.stringify([{ digest }]),
              session_id: "other-executor",
            },
          ];
    return Promise.resolve(
      Response.json({
        complete: true,
        origin: "runner",
        partial: true,
        records,
      }),
    );
  });
  const root = mountRunnerView();

  await waitForText(root, "Session from runner B");
  expect(root.textContent).toContain("Runner replica · Complete source");
  expect(root.textContent).toContain("Retry 1: old → new after 123ms");
  await waitForText(root, "Retry 2: old → newer after 456ms");
  expect(root.textContent).not.toContain("Runner terminal pairing code");
  const session = root.querySelector("button:not([disabled])");
  if (!(session instanceof HTMLButtonElement))
    throw new Error("Missing session");
  session.click();
  await waitForText(root, "Offline transcript");
  const image = root.querySelector("img");
  if (!(image instanceof HTMLImageElement))
    throw new Error("Missing attachment");
  expect(image.getAttribute("src")).toBe(`/api/local/blob/${digest}`);
  expect(image.getBoundingClientRect().width).toBeGreaterThan(0);
  const mutation = root.querySelector("button[disabled]");
  if (!(mutation instanceof HTMLButtonElement)) {
    throw new Error("Missing disabled mutation control");
  }
  expect(getComputedStyle(mutation).cursor).toBe("not-allowed");
  disposeRunnerView();
});

test("serializes view polling and aborts its read on disposal", async () => {
  let viewRequests = 0;
  let activeViews = 0;
  let maximumActiveViews = 0;
  mockRunnerFetch((_url, init) => {
    viewRequests += 1;
    activeViews += 1;
    maximumActiveViews = Math.max(maximumActiveViews, activeViews);
    return abortableResponse(init, () => {
      activeViews -= 1;
    });
  });
  const root = mountRunnerView();

  await expectRequestCount(() => viewRequests, 1);
  await delay(2_100);
  expect([viewRequests, maximumActiveViews]).toEqual([1, 1]);
  disposeRunnerView();
  await vi.waitFor(() => {
    expect(activeViews).toBe(0);
  });
  root.remove();
});

test("aborts the previous transcript read when another session is selected", async () => {
  let abortedSession: string | undefined;
  mockRunnerFetch((url, init) => {
    if (url.searchParams.get("entity") === "agent_sessions") {
      return sessionViewResponse([
        { id: "first", title: "First session" },
        { id: "second", title: "Second session" },
      ]);
    }
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (sessionId === "second") {
      return Promise.resolve(completeView([{ content: "Second transcript" }]));
    }
    return abortableResponse(init, () => {
      abortedSession = sessionId;
    });
  });
  const root = mountRunnerView();
  await waitForText(root, "Second session");
  const buttons = root.querySelectorAll("button");
  buttons[0]?.click();
  buttons[1]?.click();

  await waitForText(root, "Second transcript");
  expect(abortedSession).toBe("first");
});

test("aborts an active transcript read when the view is disposed", async () => {
  let transcriptAborted = false;
  let transcriptRequests = 0;
  mockRunnerFetch((url, init) => {
    const entity = url.searchParams.get("entity");
    if (entity !== "agent_messages") {
      return sessionViewResponse([{ id: "first", title: "First session" }]);
    }
    transcriptRequests += 1;
    return abortableResponse(init, () => {
      transcriptAborted = true;
    });
  });
  const root = mountRunnerView();
  await waitForText(root, "First session");
  root.querySelector("button")?.click();
  await expectRequestCount(() => transcriptRequests, 1);

  disposeRunnerView();
  await vi.waitFor(() => {
    expect(transcriptAborted).toBe(true);
  });
});

test("recovers after a transient view failure", async () => {
  let viewRequests = 0;
  mockRunnerFetch(() => {
    viewRequests += 1;
    return Promise.resolve(
      viewRequests === 1
        ? Response.json({ error: "joining" }, { status: 503 })
        : completeView([{ id: "ready", title: "Ready session" }]),
    );
  });
  const root = mountRunnerView();

  await waitForText(root, "The runner replica is not ready.");
  await waitForText(root, "Ready session");
  expect(root.textContent).not.toContain("The runner replica is not ready.");
  disposeRunnerView();
});

test("serializes status polling and stops requests and updates after disposal", async () => {
  let requests = 0;
  let active = 0;
  let maximumActive = 0;
  let resolveStatus: ((response: Response) => void) | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    requests += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    return abortableResponse(
      init,
      () => {
        active -= 1;
      },
      (resolve) => {
        resolveStatus = (response) => {
          active -= 1;
          resolve(response);
        };
      },
    );
  });
  const root = mountRunnerView();

  await expectRequestCount(() => requests, 1);
  await delay(1_100);
  expect([maximumActive, requests]).toEqual([1, 1]);
  disposeRunnerView();
  resolveStatus?.(Response.json({ complete: true }));
  await delay(1_100);
  expect(requests).toBe(1);
  expect(root.textContent).toBe("");
});
