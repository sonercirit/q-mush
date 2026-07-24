import { createSignal, onCleanup, onMount, type JSX } from "solid-js";
import {
  canOfferPwaInstall,
  createPwaViewState,
  isBeforeInstallPromptEvent,
  isIosDevice,
  isServiceWorkerRegistrationLike,
  isStandalonePwa,
  registerQmushServiceWorker,
  watchForServiceWorkerUpdate,
} from "./pwa-client.ts";
import { PwaStatus } from "./pwa-status.tsx";

export function PwaController(props: {
  readonly onOfflineChange: (offline: boolean) => void;
  readonly onOnline: () => Promise<boolean>;
}): JSX.Element {
  const initialState = createPwaViewState(
    typeof navigator === "undefined" ? false : !navigator.onLine,
  );
  const [installPrompt, setInstallPrompt] = createSignal(
    initialState.installPrompt,
  );
  const [installDismissed, setInstallDismissed] = createSignal(false);
  const [installed, setInstalled] = createSignal(initialState.installed);
  const [iosInstallAvailable, setIosInstallAvailable] = createSignal(
    initialState.iosInstallAvailable,
  );
  const [iosInstallDismissed, setIosInstallDismissed] = createSignal(false);
  const [offline, setOffline] = createSignal(initialState.offline);
  const [updateAvailable, setUpdateAvailable] = createSignal(
    initialState.updateAvailable,
  );
  const [updateDismissed, setUpdateDismissed] = createSignal(false);

  const install = async (): Promise<void> => {
    const prompt = installPrompt();
    if (prompt === undefined) {
      return;
    }

    try {
      setInstallPrompt(undefined);
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstalled(true);
      }
    } catch {
      // Browsers can withdraw a captured prompt when installability changes.
    }
  };

  onMount(() => {
    const standalone = isStandalonePwa(
      window.matchMedia("(display-mode: standalone)"),
      "standalone" in navigator && (navigator.standalone ?? false),
    );
    const ios = isIosDevice(navigator.userAgent, navigator.maxTouchPoints);
    const handleBeforeInstall = (event: Event): void => {
      if (isBeforeInstallPromptEvent(event)) {
        event.preventDefault();
        setInstallDismissed(false);
        setInstallPrompt(event);
      }
    };
    const handleInstalled = (): void => {
      setInstalled(true);
      setInstallPrompt(undefined);
    };
    let onlineAttempt = 0;
    const setConnectionState = (nextOffline: boolean): void => {
      setOffline(nextOffline);
      props.onOfflineChange(nextOffline);
    };
    const handleOffline = (): void => {
      onlineAttempt += 1;
      setConnectionState(true);
    };
    const handleOnline = (): void => {
      const attempt = ++onlineAttempt;
      void Promise.resolve()
        .then(() => props.onOnline())
        .then(
          (connected) => {
            if (attempt === onlineAttempt) {
              setConnectionState(!connected || !navigator.onLine);
            }
          },
          () => {
            if (attempt === onlineAttempt) {
              setConnectionState(true);
            }
          },
        );
    };

    const startsOffline = !navigator.onLine;
    setInstalled(standalone);
    setIosInstallAvailable(!standalone && ios);
    setConnectionState(startsOffline);
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    onCleanup(() => {
      onlineAttempt += 1;
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    });

    const supportsServiceWorkers = "serviceWorker" in navigator;
    const initialController = supportsServiceWorkers
      ? navigator.serviceWorker.controller
      : null;
    const worker = registerQmushServiceWorker({
      addWindowListener: (type, listener) => {
        window.addEventListener(type, listener, { once: true });
        return () => {
          window.removeEventListener(type, listener);
        };
      },
      enabled:
        import.meta.env.PROD &&
        window.isSecureContext &&
        supportsServiceWorkers,
      loaded: document.readyState === "complete",
      register: (path, options) =>
        navigator.serviceWorker.register(path, options),
    });
    let stopWatching = (): void => undefined;
    let watchActive = true;
    onCleanup(() => {
      watchActive = false;
      worker.cancel();
      stopWatching();
    });
    void worker.registration.then((registration) => {
      if (watchActive && isServiceWorkerRegistrationLike(registration)) {
        stopWatching = watchForServiceWorkerUpdate(
          registration,
          navigator.serviceWorker,
          () => {
            setUpdateDismissed(false);
            setUpdateAvailable(true);
          },
          initialController,
        );
      }
    });
  });

  return (
    <PwaStatus
      installed={installed()}
      installAvailable={
        !installDismissed() &&
        canOfferPwaInstall(installed(), installPrompt() !== undefined, false)
      }
      iosInstallAvailable={!iosInstallDismissed() && iosInstallAvailable()}
      loading={offline()}
      offline={offline()}
      onDismissInstall={() => setInstallDismissed(true)}
      onDismissIosInstall={() => setIosInstallDismissed(true)}
      onDismissUpdate={() => setUpdateDismissed(true)}
      onInstall={() => void install()}
      onReload={() => {
        window.location.reload();
      }}
      updateAvailable={updateAvailable() && !updateDismissed()}
    />
  );
}
