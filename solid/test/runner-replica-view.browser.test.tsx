import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import { RunnerReplicaView } from "../runner-replica-view.tsx";
import "../styles.css";

const digest = "a".repeat(64);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test("real Chromium reads sessions and renders replica attachments read-only", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = new URL(
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input,
      location.origin,
    );
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
  const root = document.createElement("div");
  document.body.append(root);
  render(() => <RunnerReplicaView />, root);

  await vi.waitFor(() => {
    expect(root.textContent).toContain("Session from runner B");
  });
  const session = root.querySelector("button:not([disabled])");
  if (!(session instanceof HTMLButtonElement))
    throw new Error("Missing session");
  session.click();
  await vi.waitFor(() => {
    expect(root.textContent).toContain("Offline transcript");
  });
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
});
