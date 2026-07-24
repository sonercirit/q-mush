export type ShortcutPlatform = "mac" | "other";
type ShortcutInputPolicy = "allow" | "ignore" | "owned";
type ShortcutLayer = "global" | "modal" | "overlay" | "scoped";

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
  readonly layer: ShortcutLayer;
  readonly scope: string;
}

export const SHORTCUT_ACTIONS = {
  closeDirectoryPicker: "close-directory-picker",
  closeShortcutHelp: "close-shortcut-help",
  continueSession: "continue-session",
  sendFollowUp: "send-follow-up",
  showShortcutHelp: "show-shortcut-help",
  startSession: "start-session",
} as const;

export type ApplicationShortcutAction =
  (typeof SHORTCUT_ACTIONS)[keyof typeof SHORTCUT_ACTIONS];

const COMPOSER_SHORTCUT_KEYS = {
  continueSession: { key: "Enter", primary: true, shift: true },
  submit: { key: "Enter", primary: true },
} as const satisfies Readonly<Record<string, ShortcutKey>>;

interface ShortcutEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export const APPLICATION_SHORTCUTS = [
  {
    action: SHORTCUT_ACTIONS.showShortcutHelp,
    context: "Application",
    input: "ignore",
    keys: [{ key: "?", shift: true }],
    label: "Show keyboard shortcuts",
    layer: "global",
    scope: "application",
  },
  {
    action: SHORTCUT_ACTIONS.startSession,
    context: "New session",
    input: "owned",
    keys: [COMPOSER_SHORTCUT_KEYS.submit],
    label: "Start session",
    layer: "scoped",
    scope: "new-session-composer",
  },
  {
    action: SHORTCUT_ACTIONS.sendFollowUp,
    context: "Selected session",
    input: "owned",
    keys: [COMPOSER_SHORTCUT_KEYS.submit],
    label: "Send follow-up",
    layer: "scoped",
    scope: "session-composer",
  },
  {
    action: SHORTCUT_ACTIONS.continueSession,
    context: "Selected session",
    input: "owned",
    keys: [COMPOSER_SHORTCUT_KEYS.continueSession],
    label: "Continue session",
    layer: "scoped",
    scope: "session-composer",
  },
  {
    action: SHORTCUT_ACTIONS.closeDirectoryPicker,
    context: "Directory picker",
    input: "allow",
    keys: [{ key: "Escape" }],
    label: "Close directory picker",
    layer: "modal",
    scope: "directory-picker",
  },
  {
    action: SHORTCUT_ACTIONS.closeShortcutHelp,
    context: "Shortcut help",
    input: "allow",
    keys: [{ key: "Escape" }],
    label: "Close keyboard shortcuts",
    layer: "overlay",
    scope: "shortcut-help",
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
  return key.length === 1 ? key.toLowerCase() : key;
}

function resolvedModifiers(
  key: ShortcutKey,
  platform: ShortcutPlatform,
): {
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
} {
  return {
    alt: modifierValue(key.alt),
    ctrl: modifierValue(key.primary)
      ? platform === "other"
      : modifierValue(key.ctrl),
    meta: modifierValue(key.primary)
      ? platform === "mac"
      : modifierValue(key.meta),
    shift: modifierValue(key.shift),
  };
}

function keySignature(key: ShortcutKey, platform: ShortcutPlatform): string {
  const modifiers = resolvedModifiers(key, platform);
  return [
    modifiers.ctrl ? "ctrl" : "",
    modifiers.meta ? "meta" : "",
    modifiers.alt ? "alt" : "",
    modifiers.shift ? "shift" : "",
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
      if (
        modifierValue(key.primary) &&
        (modifierValue(key.ctrl) || modifierValue(key.meta))
      ) {
        throw new Error(
          `Keyboard shortcut ${definition.label} combines primary with a platform-specific modifier`,
        );
      }
      for (const platform of ["mac", "other"] as const) {
        const signature = `${definition.scope}:${platform}:${keySignature(key, platform)}`;
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
}

function shortcutRegistryTestApi() {
  return {
    assertNoShortcutConflicts,
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
  return detectShortcutPlatform(
    typeof navigator === "undefined"
      ? ""
      : `${navigator.platform} ${navigator.userAgent}`,
  );
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

function shortcutDisplayKey(key: ShortcutKey): string {
  return key.key === "?" && modifierValue(key.shift) ? "/" : key.key;
}

export function shortcutAriaKey(
  key: ShortcutKey,
  platform: ShortcutPlatform,
): string {
  return [...keyModifiers(key, platform), shortcutDisplayKey(key)].join("+");
}

export function shortcutDisplayLabel(
  key: ShortcutKey,
  platform: ShortcutPlatform,
): string {
  const labels = keyModifiers(key, platform)
    .filter((modifier) => key.key !== "?" || modifier !== "Shift")
    .map((modifier) => {
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
  const modifiers = resolvedModifiers(key, platform);
  return (
    event.altKey === modifiers.alt &&
    event.ctrlKey === modifiers.ctrl &&
    event.metaKey === modifiers.meta &&
    event.shiftKey === modifiers.shift &&
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

function eventIsUnsafe(event: KeyboardEvent): boolean {
  const legacyKeyCode: unknown = Reflect.get(event, "keyCode");
  return (
    event.isComposing ||
    legacyKeyCode === 229 ||
    event.key === "Process" ||
    event.key === "Unidentified" ||
    event.getModifierState("AltGraph")
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
  readonly #changeListeners = new Set<() => void>();
  #disposed = false;
  readonly #eventTarget:
    Pick<Document, "addEventListener" | "removeEventListener"> | undefined;
  readonly #listener: (event: KeyboardEvent) => void;
  readonly #platform: ShortcutPlatform;
  readonly #registrations: ActiveShortcutRegistration[] = [];
  readonly #scopePriorities = new Map<string, number>();
  #nextRegistrationId = 0;

  constructor(options: KeyboardShortcutRegistryOptions = {}) {
    this.#eventTarget =
      "eventTarget" in options
        ? options.eventTarget
        : typeof document === "undefined"
          ? undefined
          : document;
    this.#platform = options.platform ?? browserShortcutPlatform();
    if (options.onChange !== undefined) {
      this.#changeListeners.add(options.onChange);
    }
    this.#listener = (event) => {
      this.handle(event);
    };
    this.#eventTarget?.addEventListener("keydown", this.#listener);
  }

  get platform(): ShortcutPlatform {
    return this.#platform;
  }

  available(): readonly AvailableShortcut[] {
    const actions = new Set(
      this.#availableRegistrations("discovery").map(({ action }) => action),
    );
    return APPLICATION_SHORTCUTS.filter(({ action }) =>
      actions.has(action),
    ).map((definition) => ({
      ...definition,
      displayKeys: definition.keys.map((key) =>
        shortcutDisplayLabel(key, this.#platform),
      ),
    }));
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#eventTarget?.removeEventListener("keydown", this.#listener);
    this.#registrations.splice(0);
    this.#scopePriorities.clear();
    this.#notifyChange();
    this.#changeListeners.clear();
  }

  handle(event: KeyboardEvent, options: ShortcutHandleOptions = {}): boolean {
    if (event.defaultPrevented || event.repeat || eventIsUnsafe(event)) {
      return false;
    }

    for (const registration of this.#availableRegistrations(
      "handling",
    ).toReversed()) {
      const { definition } = registration;
      if (
        (options.actions !== undefined &&
          !options.actions.includes(registration.action)) ||
        !definition.keys.some((key) =>
          shortcutMatches(event, key, this.#platform),
        ) ||
        !this.#targetMatches(registration, event.target)
      ) {
        continue;
      }

      event.preventDefault();
      event.stopPropagation();
      registration.handler();
      return true;
    }

    return false;
  }

  isAvailable(action: ApplicationShortcutAction): boolean {
    return this.#availableRegistrations("handling").some(
      (registration) => registration.action === action,
    );
  }

  register(registration: ShortcutRegistration): () => void {
    if (this.#disposed) {
      throw new Error("The keyboard shortcut registry is disposed");
    }
    const definition = shortcutDefinition(registration.action);
    const active: ActiveShortcutRegistration = {
      ...registration,
      definition,
      registrationId: this.#nextRegistrationId++,
    };
    this.#registrations.push(active);
    this.#scopePriorities.set(definition.scope, active.registrationId);
    this.#notifyChange();

    return () => {
      const index = this.#registrations.findIndex(
        ({ registrationId }) => registrationId === active.registrationId,
      );
      if (index !== -1) {
        this.#registrations.splice(index, 1);
        this.#refreshScopePriority(active.definition.scope);
        this.#notifyChange();
      }
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.#disposed) {
      return () => undefined;
    }
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  #availableRegistrations(
    mode: "discovery" | "handling",
  ): readonly ActiveShortcutRegistration[] {
    const available = this.#registrations.filter((registration) =>
      registration.available(),
    );
    const topRegistration = (
      layer: Extract<ShortcutLayer, "modal" | "overlay">,
    ): ActiveShortcutRegistration | undefined =>
      available
        .filter(({ definition }) => definition.layer === layer)
        .toSorted(
          (left, right) =>
            this.#scopePriority(left.definition.scope) -
            this.#scopePriority(right.definition.scope),
        )
        .at(-1);
    const overlay = topRegistration("overlay");
    const modal = topRegistration("modal");
    const blocker = overlay ?? modal;

    return available.filter(({ definition }) => {
      if (mode === "discovery") {
        if (overlay !== undefined) {
          return (
            definition.layer === "global" ||
            (definition.layer === "overlay" &&
              definition.scope === overlay.definition.scope) ||
            (modal === undefined && definition.layer === "scoped")
          );
        }
        if (modal !== undefined) {
          return (
            definition.layer === "modal" &&
            definition.scope === modal.definition.scope
          );
        }
        return definition.layer === "global" || definition.layer === "scoped";
      }
      if (definition.layer === "global") {
        return blocker === undefined;
      }
      if (definition.layer === "overlay") {
        return overlay?.definition.scope === definition.scope;
      }
      if (blocker === undefined) {
        return definition.layer === "scoped";
      }
      return (
        definition.layer === blocker.definition.layer &&
        definition.scope === blocker.definition.scope
      );
    });
  }

  #notifyChange(): void {
    for (const listener of this.#changeListeners) {
      listener();
    }
  }

  #refreshScopePriority(scope: string): void {
    const remaining = this.#registrations.findLast(
      ({ definition }) => definition.scope === scope,
    );
    if (remaining === undefined) {
      this.#scopePriorities.delete(scope);
    } else {
      this.#scopePriorities.set(scope, remaining.registrationId);
    }
  }

  #scopePriority(scope: string): number {
    return this.#scopePriorities.get(scope) ?? -1;
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
