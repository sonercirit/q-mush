import { type JSX } from "solid-js";
import {
  ShortcutProvider,
  shortcutClientApi,
} from "../../solid/shortcut-client.tsx";
import type { KeyboardShortcutRegistry } from "../../solid/shortcut-registry.ts";

export function ShortcutTestView(props: {
  readonly registry: KeyboardShortcutRegistry;
}): JSX.Element {
  const TestPanel = shortcutClientApi.shortcutClientTestApi().ShortcutTestPanel;
  return (
    <ShortcutProvider registry={props.registry}>
      <TestPanel registry={props.registry} />
    </ShortcutProvider>
  );
}
