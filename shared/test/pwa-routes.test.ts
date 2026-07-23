import { expect, test } from "vitest";
import {
  APP_PATH,
  APP_SCRIPT_PATH,
  MANIFEST_PATH,
  PWA_ICON_192_PATH,
  PWA_ICON_512_MASKABLE_PATH,
  PWA_ICON_512_PATH,
  SERVICE_WORKER_PATH,
  STYLESHEET_PATH,
} from "../routes.ts";

test("defines same-origin PWA shell routes", () => {
  expect([
    APP_PATH,
    APP_SCRIPT_PATH,
    MANIFEST_PATH,
    PWA_ICON_192_PATH,
    PWA_ICON_512_PATH,
    PWA_ICON_512_MASKABLE_PATH,
    SERVICE_WORKER_PATH,
    STYLESHEET_PATH,
  ]).toEqual([
    "/app",
    "/app.js",
    "/manifest.webmanifest",
    "/icons/q-mush-192.png",
    "/icons/q-mush-512.png",
    "/icons/q-mush-maskable-512.png",
    "/service-worker.js",
    "/styles.css",
  ]);
});
