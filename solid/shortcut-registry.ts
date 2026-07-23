export type ShortcutPlatform = "mac" | "other";
type ShortcutInputPolicy = "allow" | "ignore" | "owned";

export interface ShortcutKey {
  readonly alt?: boolean;
  readonly ctrl?: boolean;
  readonly key: string;
  readonly meta?: boolean;
  readonly primary?: boolean;
  readonly shift?: boolean;
}

export interface ShortcutDefinition {
  readonly action: string;
  readonly context: string;
  readonly input: ShortcutInputPolicy;
  readonly keys: readonly ShortcutKey[];
  readonly label: string;
  readonly scope: string;
}

export const SHORTCUT_ACTIONS = {
  closeDirectoryPicker: "close-directory-picker",
  sendFollowUp: "send-follow-up",
  showShortcutHelp: "show-shortcut-help",
  startSession: "start-session",
} as const;

export type ApplicationShortcutAction =
  (typeof SHORTCUT_ACTIONS)[keyof typeof SHORTCUT_ACTIONS];

const COMPOSER_SHORTCUT_KEYS = {
  steer: { key: "Enter", shift: true },
  submit: { key: "Enter", primary: true },
} as const satisfies Readonly<Record<string, ShortcutKey>>;

type ComposerShortcutAction = "steer" | "submit";

interface ShortcutEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

type ComposerShortcutEvent = ShortcutEvent;

function composerShortcutMatches(
  event: ComposerShortcutEvent,
  action: ComposerShortcutAction,
  platform: ShortcutPlatform,
): boolean {
  return shortcutMatches(event, COMPOSER_SHORTCUT_KEYS[action], platform);
}

export const APPLICATION_SHORTCUTS = [
  {
    action: SHORTCUT_ACTIONS.showShortcutHelp,
    context: "Application",
    input: "ignore",
    keys: [{ key: "?" }],
    label: "Show keyboard shortcuts",
    scope: "application",
  },
  {
    action: SHORTCUT_ACTIONS.startSession,
    context: "New session",
    input: "owned",
    keys: [COMPOSER_SHORTCUT_KEYS.submit],
    label: "Start session",
    scope: "new-session-composer",
  },
  {
    action: SHORTCUT_ACTIONS.sendFollowUp,
    context: "Selected session",
    input: "owned",
    keys: [COMPOSER_SHORTCUT_KEYS.submit],
    label: "Send follow-up",
    scope: "session-composer",
  },
  {
    action: SHORTCUT_ACTIONS.closeDirectoryPicker,
    context: "Directory picker",
    input: "allow",
    keys: [{ key: "Escape" }],
    label: "Close directory picker",
    scope: "directory-picker",
  },
] as const satisfies readonly ShortcutDefinition[];

const DEFINITIONS_BY_ACTION = new Map(
  APPLICATION_SHORTCUTS.map((definition) => [definition.action, definition]),
);

export function shortcutDefinition(
  action: ApplicationShortcutAction,
): (typeof APPLICATION_SHORTCUTS)[number] {
  const definition = DEFINITIONS_BY_ACTION.get(action);
  if (definition === undefined) {
    throw new Error(`Unknown keyboard shortcut action: ${action}`);
  }
  return definition;
}

function modifierValue(value: boolean | undefined): boolean {
  return value === true;
}

function normalizedKey(key: string): string {
  return key.length === 1 ? key.toLocaleLowerCase() : key;
}

function keySignature(key: ShortcutKey): string {
  return [
    modifierValue(key.primary) ? "primary" : "",
    modifierValue(key.ctrl) ? "ctrl" : "",
    modifierValue(key.meta) ? "meta" : "",
    modifierValue(key.alt) ? "alt" : "",
    modifierValue(key.shift) ? "shift" : "",
    normalizedKey(key.key),
  ].join("+");
}

function assertNoShortcutConflicts(
  definitions: readonly ShortcutDefinition[],
): void {
  const actions = new Set<string>();
  const bindings = new Map<string, ShortcutDefinition>();

  for (const definition of definitions) {
    if (actions.has(definition.action)) {
      throw new Error(
        `Duplicate keyboard shortcut action: ${definition.action}`,
      );
    }
    actions.add(definition.action);

    for (const key of definition.keys) {
      const signature = `${definition.scope}:${keySignature(key)}`;
      const existing = bindings.get(signature);
      if (existing !== undefined) {
        throw new Error(
          `Keyboard shortcut conflict: ${existing.label} and ${definition.label}`,
        );
      }
      bindings.set(signature, definition);
    }
  }
}

function shortcutRegistryTestApi() {
  return {
    assertNoShortcutConflicts,
    composerShortcutMatches,
    composerShortcutKeys: COMPOSER_SHORTCUT_KEYS,
    detectShortcutPlatform,
    shortcutMatches,
  };
}

assertNoShortcutConflicts(APPLICATION_SHORTCUTS);

function detectShortcutPlatform(platform: string): ShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/u.test(platform) ? "mac" : "other";
}

function browserShortcutPlatform(): ShortcutPlatform {
  return detectShortcutPlatform(navigator.platform);
}

function keyModifiers(
  key: ShortcutKey,
  platform: ShortcutPlatform,
): readonly string[] {
  const modifiers: string[] = [];
  if (modifierValue(key.primary)) {
    modifiers.push(platform === "mac" ? "Meta" : "Control");
  }
  if (modifierValue(key.ctrl)) {
    modifiers.push("Control");
  }
  if (modifierValue(key.alt)) {
    modifiers.push("Alt");
  }
  if (modifierValue(key.shift)) {
    modifiers.push("Shift");
  }
  if (modifierValue(key.meta)) {
    modifiers.push("Meta");
  }
  return modifiers;
}

export function shortcutAriaKey(
  key: ShortcutKey,
  platform: ShortcutPlatform,
): string {
  return [...keyModifiers(key, platform), key.key].join("+");
}

export function shortcutDisplayLabel(
  key: ShortcutKey,
  platform: ShortcutPlatform,
): string {
  const labels = keyModifiers(key, platform).map((modifier) => {
    if (modifier === "Meta" && platform === "mac") {
      return "⌘";
    }
    if (modifier === "Control") {
      return "Ctrl";
    }
    return modifier;
  });
  return [...labels, key.key].join(" ");
}

function shortcutMatches(
  event: ShortcutEvent,
  key: ShortcutKey,
  platform: ShortcutPlatform,
): boolean {
  const primaryMatches = modifierValue(key.primary)
    ? platform === "mac"
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey
    : event.metaKey === modifierValue(key.meta) &&
      event.ctrlKey === modifierValue(key.ctrl);

  return (
    primaryMatches &&
    event.altKey === modifierValue(key.alt) &&
    event.shiftKey === modifierValue(key.shift) &&
    normalizedKey(event.key) === normalizedKey(key.key)
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return (
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

function eventIsComposing(event: KeyboardEvent): boolean {
  return (
    event.isComposing || event.key === "Process" || event.key === "Unidentified"
  );
}

export interface ShortcutRegistration {
  readonly action: ApplicationShortcutAction;
  readonly available: () => boolean;
  readonly handler: () => void;
  readonly target?: () => EventTarget | undefined;
}

export interface AvailableShortcut extends ShortcutDefinition {
  readonly displayKeys: readonly string[];
}

interface ActiveShortcutRegistration extends ShortcutRegistration {
  readonly definition: (typeof APPLICATION_SHORTCUTS)[number];
  readonly registrationId: number;
}

interface KeyboardShortcutRegistryOptions {
  readonly eventTarget?:
    Pick<Document, "addEventListener" | "removeEventListener"> | undefined;
  readonly onChange?: () => void;
  readonly platform?: ShortcutPlatform;
}

export interface ShortcutHandleOptions {
  readonly actions?: readonly ApplicationShortcutAction[];
}

/** @internal Test access for shortcut primitives that stay encapsulated in production. */
export const shortcutRegistryApi = { shortcutRegistryTestApi };

export class KeyboardShortcutRegistry {
  readonly #eventTarget:
    Pick<Document, "addEventListener" | "removeEventListener"> | undefined;
  readonly #listener: (event: KeyboardEvent) => void;
  readonly #onChange: (() => void) | undefined;
  readonly #platform: ShortcutPlatform;
  readonly #registrations: ActiveShortcutRegistration[] = [];
  #nextRegistrationId = 0;

  constructor(options: KeyboardShortcutRegistryOptions = {}) {
    this.#eventTarget =
      "eventTarget" in options
        ? options.eventTarget
        : typeof document === "undefined"
          ? undefined
          : document;
    this.#platform = options.platform ?? browserShortcutPlatform();
    this.#onChange = options.onChange;
    this.#listener = (event) => {
      this.handle(event);
    };
    this.#eventTarget?.addEventListener("keydown", this.#listener);
  }

  get platform(): ShortcutPlatform {
    return this.#platform;
  }

  available(): readonly AvailableShortcut[] {
    const actions = new Set<string>();
    const available: AvailableShortcut[] = [];
    for (const registration of this.#registrations.toReversed()) {
      if (actions.has(registration.action) || !registration.available()) {
        continue;
      }
      actions.add(registration.action);
      available.push({
        ...registration.definition,
        displayKeys: registration.definition.keys.map((key) =>
          shortcutDisplayLabel(key, this.#platform),
        ),
      });
    }
    return available.toReversed();
  }

  dispose(): void {
    this.#eventTarget?.removeEventListener("keydown", this.#listener);
    this.#registrations.splice(0);
    this.#onChange?.();
  }

  handle(event: KeyboardEvent, options: ShortcutHandleOptions = {}): boolean {
    if (event.defaultPrevented || event.repeat || eventIsComposing(event)) {
      return false;
    }

    for (const registration of this.#registrations.toReversed()) {
      const { definition } = registration;
      if (
        (options.actions !== undefined &&
          !options.actions.includes(registration.action)) ||
        !registration.available() ||
        !definition.keys.some((key) =>
          shortcutMatches(event, key, this.#platform),
        ) ||
        !this.#targetMatches(registration, event.target)
      ) {
        continue;
      }

      event.preventDefault();
      registration.handler();
      return true;
    }

    return false;
  }

  register(registration: ShortcutRegistration): () => void {
    const definition = shortcutDefinition(registration.action);

    const active: ActiveShortcutRegistration = {
      ...registration,
      definition,
      registrationId: this.#nextRegistrationId++,
    };
    this.#registrations.push(active);
    this.#onChange?.();

    return () => {
      const index = this.#registrations.findIndex(
        ({ registrationId }) => registrationId === active.registrationId,
      );
      if (index !== -1) {
        this.#registrations.splice(index, 1);
        this.#onChange?.();
      }
    };
  }

  #targetMatches(
    registration: ActiveShortcutRegistration,
    target: EventTarget | null,
  ): boolean {
    switch (registration.definition.input) {
      case "allow":
        return true;
      case "ignore":
        return !isEditableTarget(target);
      case "owned": {
        const owner = registration.target?.();
        return owner !== undefined && owner === target;
      }
    }
  }
}
