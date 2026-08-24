import { expect, test, vi } from "vitest";
import { TEST_SESSION_FORK_SELECTION } from "../../shared/test/session-fork-fixtures.ts";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import {
  createSessionController,
  type SessionController,
} from "../session-controller.ts";
import { initialSessionViewState } from "../session-state.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { selectedSessionViewState } from "./session-selected-state.ts";

type ForkCommand = NonNullable<
  Parameters<typeof createSessionController>[3]
>["command"];

function forkedSession() {
  return {
    ...TEST_SESSION_DETAIL,
    id: "session-forked",
    title: "Fork of Fix the app",
  };
}

function forkController(command: ForkCommand): SessionController {
  const state = initialSessionViewState();
  return createSessionController(
    createReactiveState<SessionViewState>(selectedSessionViewState(state)),
    undefined,
    null,
    { command },
  );
}

function expectForkSelection(
  controller: SessionController,
  forked: ReturnType<typeof forkedSession>,
): void {
  expect(controller.state).toMatchObject({
    detail: forked,
    error: undefined,
    forking: false,
    selectedId: forked.id,
  });
}

test("forks from a transcript message and selects the returned session", async () => {
  const forkPoint = "message-1";
  const forked = forkedSession();
  const command = vi.fn<ForkCommand>();
  const completed = Promise.resolve(forked);
  command.mockImplementation(() => completed);
  const controller = forkController(command);

  await controller.fork(forkPoint);

  expect(command).toHaveBeenCalledWith(SESSION_REALTIME_OPERATIONS.fork, {
    forkPointMessageId: forkPoint,
    sourceSessionId: TEST_SESSION_DETAIL.id,
    workspaceId: TEST_SESSION_DETAIL.workspaceId,
  });
  expectForkSelection(controller, forked);
  expect(controller.state.sessions?.map(({ id }) => id)).toContain(forked.id);
});

test("sends an optional provider selection with the fork", async () => {
  const command = vi.fn<ForkCommand>(() => Promise.resolve(forkedSession()));
  const controller = forkController(command);
  const selection = TEST_SESSION_FORK_SELECTION;

  await controller.fork("message-1", selection);

  expect(command).toHaveBeenCalledWith(
    SESSION_REALTIME_OPERATIONS.fork,
    expect.objectContaining(selection),
  );
});

test("blocks a second fork while the first fork is pending", async () => {
  let resolveFork: ((value: unknown) => void) | undefined;
  const pendingFork = new Promise<unknown>((resolve) => {
    resolveFork = resolve;
  });
  const command = vi.fn<ForkCommand>(() => pendingFork);
  const controller = forkController(command);

  const first = controller.fork("message-1");
  const second = controller.fork("message-1");

  expect(controller.state.forking).toBe(true);
  expect(command).toHaveBeenCalledOnce();
  resolveFork?.({ ...TEST_SESSION_DETAIL, id: "session-forked" });
  await Promise.all([first, second]);
  expect(controller.state.forking).toBe(false);
});

test("reconciles an unknown fork outcome to the newly listed session", async () => {
  const unknown = Object.assign(new Error("outcome_unknown"), {
    code: "outcome_unknown",
  });
  const forked = forkedSession();
  const command = vi.fn<ForkCommand>(() => Promise.resolve());
  command.mockRejectedValueOnce(unknown);
  command.mockImplementationOnce(() =>
    Promise.resolve({ sessions: [TEST_SESSION_DETAIL, forked] }),
  );
  command.mockResolvedValueOnce(forked);
  const controller = forkController(command);
  const uncertainFork = controller.fork("message-1");

  await uncertainFork;

  const operations = command.mock.calls.map((call) => call[0]);
  expect(operations).toEqual([
    SESSION_REALTIME_OPERATIONS.fork,
    SESSION_REALTIME_OPERATIONS.subscribe,
    SESSION_REALTIME_OPERATIONS.read,
  ]);
  expectForkSelection(controller, forked);
  expect(controller.state.history.page).toBeUndefined();
});
