import { createRoot } from "solid-js";
import { expect, test, vi } from "vitest";
import { testDeferred } from "../../shared/test/promise-fixtures.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import type { SessionCommandTransport } from "../session-transport.ts";
import { restoreFetchAfterEach } from "./controller-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

restoreFetchAfterEach();

test("aggregate refresh does not replace a newer selected snapshot", async () => {
  const list = testDeferred<unknown>();
  const detail = testDeferred<unknown>();
  const transport: SessionCommandTransport = {
    command: (operation) => {
      if (operation === SESSION_REALTIME_OPERATIONS.subscribe) {
        return list.promise;
      }
      if (operation === SESSION_REALTIME_OPERATIONS.read) {
        return detail.promise;
      }
      return Promise.reject(new Error("Unexpected command"));
    },
  };
  const controller = createRoot(
    () => new SessionController(undefined, undefined, null, transport),
  );
  const initialLoad = controller.load();
  list.resolve({ sessions: [summaryFromDetail(TEST_SESSION_DETAIL)] });
  detail.resolve(TEST_SESSION_DETAIL);
  await initialLoad;

  const refreshList = testDeferred<unknown>();
  const refreshDetail = testDeferred<unknown>();
  vi.spyOn(transport, "command")
    .mockImplementationOnce(() => refreshDetail.promise)
    .mockImplementationOnce(() => refreshList.promise);
  const refresh = controller.refresh();
  const live = {
    ...TEST_SESSION_DETAIL,
    title: "newer live snapshot",
    updatedAt: TEST_SESSION_DETAIL.updatedAt + 2,
  };
  controller.applyDetail(live);
  refreshList.resolve({
    sessions: [
      summaryFromDetail({
        ...TEST_SESSION_DETAIL,
        credentialId: "target-credential",
        updatedAt: TEST_SESSION_DETAIL.updatedAt + 1,
      }),
    ],
  });
  refreshDetail.resolve({
    ...TEST_SESSION_DETAIL,
    credentialId: "target-credential",
    updatedAt: TEST_SESSION_DETAIL.updatedAt + 1,
  });
  await refresh;

  expect(controller.state.detail).toEqual(live);
  expect(controller.state.sessions?.[0]).toEqual(summaryFromDetail(live));
});
