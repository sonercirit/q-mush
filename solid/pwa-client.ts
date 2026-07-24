import { SERVICE_WORKER_PATH } from "../shared/routes.ts";

interface DisplayModeQuery {
  readonly matches: boolean;
}

export interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

interface ServiceWorkerRegistrationLike {
  addEventListener(type: "updatefound", listener: () => void): void;
  readonly installing?: ServiceWorkerLike | null;
  removeEventListener(type: "updatefound", listener: () => void): void;
  readonly waiting?: ServiceWorkerLike | null;
}

interface ServiceWorkerContainerLike {
  addEventListener(type: "controllerchange", listener: () => void): void;
  readonly controller: ServiceWorkerLike | null;
  removeEventListener(type: "controllerchange", listener: () => void): void;
}

export function isServiceWorkerRegistrationLike(
  value: unknown,
): value is ServiceWorkerRegistrationLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "addEventListener" in value &&
    typeof value.addEventListener === "function" &&
    "removeEventListener" in value &&
    typeof value.removeEventListener === "function"
  );
}

interface ServiceWorkerLike extends EventTarget {
  readonly state: string;
}

export interface ServiceWorkerRegistrationResult {
  cancel(): void;
  readonly registration: Promise<ServiceWorkerRegistrationLike | undefined>;
}

interface RegistrationOptions {
  readonly addWindowListener: (
    type: "load",
    listener: () => void,
  ) => () => void;
  readonly enabled: boolean;
  readonly loaded: boolean;
  readonly register: (
    path: string,
    options: { readonly scope: string; readonly updateViaCache: "none" },
  ) => Promise<ServiceWorkerRegistrationLike>;
}

export function createPwaViewState(offline = false): PwaViewState {
  return {
    installPrompt: undefined,
    installed: false,
    iosInstallAvailable: false,
    offline,
    updateAvailable: false,
  };
}

export interface PwaViewState {
  readonly installPrompt: BeforeInstallPromptEvent | undefined;
  readonly installed: boolean;
  readonly iosInstallAvailable: boolean;
  readonly offline: boolean;
  readonly updateAvailable: boolean;
}

export function isStandalonePwa(
  displayMode: DisplayModeQuery,
  navigatorStandalone: boolean,
): boolean {
  return displayMode.matches || navigatorStandalone;
}

export function isIosDevice(
  userAgent: string,
  maxTouchPoints: number,
): boolean {
  return (
    userAgent.includes("iPad") ||
    userAgent.includes("iPhone") ||
    userAgent.includes("iPod") ||
    (userAgent.includes("Macintosh") && maxTouchPoints > 1)
  );
}

export function canOfferPwaInstall(
  installed: boolean,
  nativePromptAvailable: boolean,
  ios: boolean,
): boolean {
  return !installed && (nativePromptAvailable || ios);
}

export function registerQmushServiceWorker(
  options: RegistrationOptions,
): ServiceWorkerRegistrationResult {
  if (!options.enabled) {
    return {
      cancel: () => undefined,
      registration: Promise.resolve(undefined),
    };
  }

  const register = (): Promise<ServiceWorkerRegistrationLike | undefined> => {
    try {
      return options
        .register(SERVICE_WORKER_PATH, { scope: "/", updateViaCache: "none" })
        .catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  };
  let active = true;
  let removeLoadListener = (): void => undefined;
  let resolvePending:
    ((value: ServiceWorkerRegistrationLike | undefined) => void) | undefined;
  const registration = options.loaded
    ? register().then((value) => (active ? value : undefined))
    : new Promise<ServiceWorkerRegistrationLike | undefined>((resolve) => {
        resolvePending = resolve;
        removeLoadListener = options.addWindowListener("load", () => {
          if (!active) {
            return;
          }
          void register().then((value) => {
            resolve(active ? value : undefined);
          });
        });
      });

  return {
    cancel() {
      active = false;
      removeLoadListener();
      resolvePending?.(undefined);
    },
    registration,
  };
}

export function watchForServiceWorkerUpdate(
  registration: ServiceWorkerRegistrationLike,
  serviceWorkers: ServiceWorkerContainerLike,
  onUpdate: () => void,
  initialController = serviceWorkers.controller,
): () => void {
  const observedWorkers = new Map<ServiceWorkerLike, () => void>();
  const notifiedWorkers = new Set<ServiceWorkerLike>();
  let active = true;
  let previousController = initialController;
  const notify = (worker: ServiceWorkerLike): void => {
    if (active && !notifiedWorkers.has(worker)) {
      notifiedWorkers.add(worker);
      onUpdate();
    }
  };
  const observe = (worker: ServiceWorkerLike | null | undefined): void => {
    if (
      worker === null ||
      worker === undefined ||
      observedWorkers.has(worker)
    ) {
      return;
    }
    const handleStateChange = (): void => {
      if (worker.state === "installed" && serviceWorkers.controller !== null) {
        notify(worker);
      }
    };
    observedWorkers.set(worker, handleStateChange);
    worker.addEventListener("statechange", handleStateChange);
    handleStateChange();
  };
  const handleUpdateFound = (): void => {
    observe(registration.installing);
  };
  const handleControllerChange = (): void => {
    const controller = serviceWorkers.controller;
    if (
      controller !== null &&
      previousController !== null &&
      controller !== previousController
    ) {
      notify(controller);
    }
    previousController = controller;
  };

  if (registration.waiting !== null && registration.waiting !== undefined) {
    notify(registration.waiting);
  }
  observe(registration.installing);
  registration.addEventListener("updatefound", handleUpdateFound);
  serviceWorkers.addEventListener("controllerchange", handleControllerChange);
  handleControllerChange();

  return () => {
    active = false;
    registration.removeEventListener("updatefound", handleUpdateFound);
    serviceWorkers.removeEventListener(
      "controllerchange",
      handleControllerChange,
    );
    for (const [worker, listener] of observedWorkers) {
      worker.removeEventListener("statechange", listener);
    }
  };
}

export function isBeforeInstallPromptEvent(
  event: Event,
): event is BeforeInstallPromptEvent {
  return (
    "prompt" in event &&
    typeof event.prompt === "function" &&
    "userChoice" in event
  );
}
