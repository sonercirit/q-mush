import { batch, createSignal, Show, type JSX } from "solid-js";
import { expect, test } from "vitest";
import { mountTestView } from "./dom-test-helpers.ts";
import { defineElementSize } from "./element-size-test-helpers.ts";
import {
  mutationTestPane,
  queryMutationPane,
  rememberPane,
  trackedDisposals,
} from "./nested-scroll-test-helpers.tsx";

const disposals = trackedDisposals();

function ReKeyedRowFixture(props: {
  readonly rowKey: string;
  readonly showFirst: boolean;
  readonly showSecond: boolean;
}): JSX.Element {
  // The lazy id re-keys the mounted pane in place instead of remounting.
  return (
    <div>
      <Show when={props.showFirst}>
        {mutationTestPane({
          get id() {
            return props.rowKey;
          },
          label: "retained",
        })}
      </Show>
      <Show when={props.showSecond}>
        {mutationTestPane({ id: "after:user-1:thinking:0", label: "claimant" })}
      </Show>
    </div>
  );
}

interface ReKeyedScenario {
  readonly claimGrownPrefix: () => void;
  readonly claimant: () => HTMLElement;
  readonly expectCleanClaimant: (pane: HTMLElement) => Promise<void>;
  readonly mountCleanClaimant: () => Promise<void>;
  readonly retained: HTMLElement;
  readonly setRowKey: (key: string) => void;
  readonly setShowFirst: (value: boolean) => void;
  readonly setShowSecond: (value: boolean) => void;
  readonly scopeKey: (label: string) => string | null;
}

// Restores are queued across two microtask hops before they land.
async function expectCleanClaimant(pane: HTMLElement): Promise<void> {
  await Promise.resolve().then(() => Promise.resolve());
  expect(pane.scrollTop).toBe(0);
}

function mountReKeyedScenario(): ReKeyedScenario {
  const [rowKey, setRowKey] = createSignal("after:user-1:thinking:0");
  const [showFirst, setShowFirst] = createSignal(true);
  const [showSecond, setShowSecond] = createSignal(false);
  const container = mountTestView(
    () => (
      <ReKeyedRowFixture
        rowKey={rowKey()}
        showFirst={showFirst()}
        showSecond={showSecond()}
      />
    ),
    disposals,
  );
  const retained = queryMutationPane(container, "retained");
  rememberPane(retained, 55);
  return {
    // One batched update grows the transcript prefix: the claimant's ref
    // runs before the retained row re-keys, exactly as in the transcript.
    claimGrownPrefix: () => {
      batch(() => {
        setRowKey("after:tool-1:thinking:0");
        setShowSecond(true);
      });
    },
    claimant: () => {
      const pane = queryMutationPane(container, "claimant");
      defineElementSize(pane, 100, 1_000);
      return pane;
    },
    expectCleanClaimant,
    mountCleanClaimant: async () => {
      setShowSecond(true);
      const pane = queryMutationPane(container, "claimant");
      defineElementSize(pane, 100, 1_000);
      await expectCleanClaimant(pane);
    },
    retained,
    scopeKey: (label) =>
      container
        .querySelector(`[data-mutation-pane-scope='${label}']`)
        ?.getAttribute("data-nested-scroll-key") ?? null,
    setRowKey,
    setShowFirst,
    setShowSecond,
  };
}

test("a row claiming a migrated key does not inherit the old row's state", async () => {
  const scenario = mountReKeyedScenario();

  // The claimant must start clean instead of restoring the offset
  // remembered under the old key. Restores run on microtasks.
  scenario.claimGrownPrefix();
  const claimant = scenario.claimant();
  expect(scenario.scopeKey("retained")).toBe("after:tool-1:thinking:0");
  expect(scenario.scopeKey("claimant")).toBe("after:user-1:thinking:0");
  await scenario.expectCleanClaimant(claimant);
  expect(scenario.retained.scrollTop).toBe(55);
});

test("a claimant re-created under its key does not restore inherited panes", async () => {
  const scenario = mountReKeyedScenario();

  // The still-mounted owner suppressed the claimant's restore; the entry
  // must now describe the claimant itself, or re-creating the claimant row
  // under the same key would restore the retained row's leftover offset.
  scenario.claimGrownPrefix();
  await scenario.expectCleanClaimant(scenario.claimant());
  // Re-create before cleanup microtasks run, as a delta replacing the row
  // does: the fresh element inherits the entry and restores from it.
  scenario.setShowSecond(false);
  await scenario.mountCleanClaimant();
});

test("a re-keyed row's released key does not leak state after it unmounts", async () => {
  const scenario = mountReKeyedScenario();

  // Re-keying must release the old key's entry: with the row later gone,
  // a stale entry would restore its offset onto an unrelated new claimant.
  scenario.setRowKey("after:tool-1:thinking:0");
  scenario.setShowFirst(false);
  await Promise.resolve();
  await Promise.resolve();
  await scenario.mountCleanClaimant();
});
