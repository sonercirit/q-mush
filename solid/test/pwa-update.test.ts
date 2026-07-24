import { expect, test } from "vitest";
import { watchForServiceWorkerUpdate } from "../pwa-client.ts";

class Worker extends EventTarget {
  state: ServiceWorkerState;

  constructor(state: ServiceWorkerState = "installing") {
    super();
    this.state = state;
  }
}

class Registration extends EventTarget {
  installing: Worker | null = null;
  waiting: Worker | null = null;
}

class UpdateScenario {
  readonly registration = new Registration();
  readonly serviceWorkers = new (class extends EventTarget {
    controller: Worker | null = null;
  })();
  updates = 0;
  #stop = (): void => undefined;

  start(initialController?: Worker | null): void {
    const update = (): void => {
      this.updates += 1;
    };
    this.#stop =
      initialController === undefined
        ? watchForServiceWorkerUpdate(
            this.registration,
            this.serviceWorkers,
            update,
          )
        : watchForServiceWorkerUpdate(
            this.registration,
            this.serviceWorkers,
            update,
            initialController,
          );
  }

  install(worker: Worker): void {
    this.registration.installing = worker;
    this.registration.dispatchEvent(new Event("updatefound"));
    worker.state = "installed";
    worker.dispatchEvent(new Event("statechange"));
  }

  replaceController(worker = new Worker("activated")): void {
    this.serviceWorkers.controller = worker;
    this.serviceWorkers.dispatchEvent(new Event("controllerchange"));
  }

  stop(): void {
    this.#stop();
  }
}

test("observes an existing installer and reports each distinct update once", () => {
  const scenario = new UpdateScenario();
  const first = new Worker();
  scenario.serviceWorkers.controller = new Worker("activated");
  scenario.registration.installing = first;
  scenario.start();

  first.state = "installed";
  first.dispatchEvent(new Event("statechange"));
  first.dispatchEvent(new Event("statechange"));
  expect(scenario.updates).toBe(1);

  scenario.install(new Worker());
  expect(scenario.updates, "second worker").toBe(2);

  scenario.stop();
  scenario.registration.installing = new Worker("installed");
  scenario.registration.dispatchEvent(new Event("updatefound"));
  expect(scenario.updates).toBe(2);
});

test("deduplicates waiting and activated notifications for one worker", () => {
  const scenario = new UpdateScenario();
  const update = new Worker("installed");
  scenario.serviceWorkers.controller = new Worker("activated");
  scenario.registration.waiting = update;
  scenario.start();

  expect(scenario.updates).toBe(1);
  scenario.replaceController(update);
  expect(scenario.updates, "waiting worker is deduplicated").toBe(1);
  scenario.stop();
});

test("reports a controller replacement before watcher attachment", () => {
  const scenario = new UpdateScenario();
  const previous = new Worker("activated");
  scenario.serviceWorkers.controller = new Worker("activated");
  scenario.start(previous);

  expect(scenario.updates).toBe(1);
  scenario.stop();
  expect(scenario.serviceWorkers.controller).not.toBe(previous);
});

test("reports replacements but not a first service worker install", () => {
  const scenario = new UpdateScenario();
  scenario.start();

  scenario.replaceController();
  expect(scenario.updates).toBe(0);
  scenario.replaceController();
  scenario.serviceWorkers.dispatchEvent(new Event("controllerchange"));
  expect(scenario.updates, "duplicate event").toBe(1);
  scenario.replaceController();
  expect(scenario.updates).toBe(2);

  scenario.stop();
  scenario.replaceController();
  expect(scenario.updates, "stopped watcher").toBe(2);
});
