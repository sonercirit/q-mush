import { expect, test } from "vitest";
import { CONFIGURED_TOOL_SETTINGS } from "../../shared/test/tool-settings-fixtures.ts";
import {
  openAndReconnectRealtimeTestConnection,
  openRealtimeTestConnection,
  type RealtimeClientTestSetup,
} from "./realtime-client-test-helpers.ts";
import { realtimeTestSetup } from "./realtime-client-test-setup.ts";

function sessionListener(events: unknown[]) {
  return (event: unknown): void => {
    events.push(event);
  };
}

interface RealtimeEventFixture {
  readonly events: unknown[];
  readonly setup: RealtimeClientTestSetup;
}

function eventFixture(): RealtimeEventFixture {
  const events: unknown[] = [];
  const setup = realtimeTestSetup({ listener: sessionListener(events) });
  return { events, setup };
}

function openFixture(
  setup: RealtimeClientTestSetup,
): RealtimeClientTestSetup["sockets"][number] | undefined {
  openRealtimeTestConnection(setup, "instance-1");
  return setup.sockets[0];
}

function openedEventFixture(): RealtimeEventFixture & {
  readonly socket: RealtimeClientTestSetup["sockets"][number] | undefined;
} {
  const fixture = eventFixture();
  return { ...fixture, socket: openFixture(fixture.setup) };
}

function reconnectRecorder(setup: RealtimeClientTestSetup): () => number {
  let reconnects = 0;
  setup.connection.onReconnect(() => {
    reconnects += 1;
  });
  return () => reconnects;
}

function assertReconnectCount(
  reconnects: () => number,
  expected: number,
  setup: RealtimeClientTestSetup,
): void {
  expect(reconnects()).toBe(expected);
  setup.connection.stop();
}

function expectedToolSettingsEvent() {
  return {
    settings: CONFIGURED_TOOL_SETTINGS,
    type: "tool_settings" as const,
  };
}

test("connects to the same-origin realtime WebSocket and decodes events", () => {
  const fixture = openedEventFixture();
  const { events, setup, socket } = fixture;

  socket?.receive('{"sessions":[],"type":"sessions"}');
  setup.requestFrames.shift()?.();

  expect(socket?.url).toBe("wss://qmush.example/api/realtime");
  expect(socket?.sent).toHaveLength(0);
  expect(events).toEqual([
    { instanceId: "instance-1", type: "ready" },
    { sessions: [], type: "sessions" },
  ]);
  setup.connection.stop();
});

test("delivers tool-settings updates immediately instead of frame-coalescing", () => {
  const fixture = openedEventFixture();
  const socket = fixture.socket;
  socket?.receive(
    '{"settings":{"executionLimitMinutes":7,"outputLimitCharacters":12345},"type":"tool_settings"}',
  );

  expect(fixture.events.at(-1)).toEqual(expectedToolSettingsEvent());
  expect(fixture.setup.requestFrames).toHaveLength(0);
  fixture.setup.connection.stop();
});

test.each([
  {
    lifecycle: (setup: RealtimeClientTestSetup) => {
      openAndReconnectRealtimeTestConnection(setup, "instance-1");
    },
    name: "notifies reconnect listeners even without pending commands",
    reconnects: 1,
  },
  {
    lifecycle: (setup: RealtimeClientTestSetup) => {
      openRealtimeTestConnection(setup, "instance-1");
      setup.connection.stop();
      setup.connection.start();
      openRealtimeTestConnection(setup, "instance-2");
    },
    name: "a stopped connection starts a fresh lifecycle",
    reconnects: 0,
  },
])("$name", ({ lifecycle, reconnects: expected }) => {
  const setup = realtimeTestSetup();
  const reconnects = reconnectRecorder(setup);

  lifecycle(setup);

  assertReconnectCount(reconnects, expected, setup);
});

test("ignores events from a stopped or replaced socket", () => {
  const { events, setup } = eventFixture();
  const stale = setup.sockets[0];
  openAndReconnectRealtimeTestConnection(setup, "instance-1");
  events.length = 0;

  stale?.receive('{"sessions":[],"type":"sessions"}');
  setup.connection.stop();
  setup.sockets[1]?.receive('{"sessions":[],"type":"sessions"}');

  expect(events).toEqual([]);
});
