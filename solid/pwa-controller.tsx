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
  readonly onOnline: () => void;
}): JSX.Element {
  const initialState = createPwaViewState();
  const [installPrompt, setInstallPrompt] = createSignal(
    initialState.installPrompt,
  );
  const [installed, setInstalled] = createSignal(initialState.installed);
  const [iosInstallAvailable, setIosInstallAvailable] = createSignal(
    initialState.iosInstallAvailable,
  );
  const [offline, setOffline] = createSignal(initialState.offline);
  const [updateAvailable, setUpdateAvailable] = createSignal(
    initialState.updateAvailable,
  );

  const install = async (): Promise<void> => {
    const prompt = installPrompt();
    if (prompt === undefined) {
      return;
    }

    setInstallPrompt(undefined);
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") {
      setInstalled(true);
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
        setInstallPrompt(event);
      }
    };
    const handleInstalled = (): void => {
      setInstalled(true);
      setInstallPrompt(undefined);
    };
    const handleOffline = (): void => {
      setOffline(true);
      props.onOfflineChange(true);
    };
    const handleOnline = (): void => {
      setOffline(false);
      props.onOfflineChange(false);
      props.onOnline();
    };

    const startsOffline = !navigator.onLine;
    setInstalled(standalone);
    setIosInstallAvailable(!standalone && ios);
    setOffline(startsOffline);
    props.onOfflineChange(startsOffline);
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    onCleanup(() => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    });

    const worker = registerQmushServiceWorker({
      addWindowListener: (type, listener) => {
        window.addEventListener(type, listener, { once: true });
      },
      enabled: import.meta.env.PROD && window.isSecureContext,
      register: (path, options) =>
        navigator.serviceWorker.register(path, options),
    });
    void worker.registration.then((registration) => {
      if (isServiceWorkerRegistrationLike(registration)) {
        watchForServiceWorkerUpdate(
          registration,
          () => navigator.serviceWorker.controller !== null,
          () => setUpdateAvailable(true),
        );
      }
    });
  });

  return (
    <PwaStatus
      installed={installed()}
      installAvailable={canOfferPwaInstall(
        installed(),
        installPrompt() !== undefined,
        false,
      )}
      iosInstallAvailable={iosInstallAvailable()}
      offline={offline()}
      onInstall={() => void install()}
      onReload={() => {
        window.location.reload();
      }}
      updateAvailable={updateAvailable()}
    />
  );
}
