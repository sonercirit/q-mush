import { render } from "solid-js/web";
import { expect, test, vi } from "vitest";
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
    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
      location.origin,
    );
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
  const { dispose, meta, root } = runnerViewFixture();

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
  dispose();
  root.remove();
  meta.remove();
  vi.restoreAllMocks();
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
    return new Promise<Response>((resolve, reject) => {
      resolveStatus = (response) => {
        active -= 1;
        resolve(response);
      };
      init?.signal?.addEventListener("abort", () => {
        active -= 1;
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  });
  const { dispose, meta, root } = runnerViewFixture();

  await vi.waitFor(() => {
    expect(requests).toBe(1);
  });
  await delay(1_100);
  expect([maximumActive, requests]).toEqual([1, 1]);
  dispose();
  root.remove();
  resolveStatus?.(Response.json({ complete: true }));
  await delay(1_100);
  expect(requests).toBe(1);
  expect(root.textContent).toBe("");

  meta.remove();
  vi.restoreAllMocks();
});
