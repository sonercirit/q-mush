import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BuildOptions, PluginOption } from "vite";
import solid from "vite-plugin-solid";
import { FAVICON_PATH } from "../shared/routes.ts";

const FAVICON_FILE_URL = new URL("../solid/favicon.svg", import.meta.url);
const OUT_DIRECTORY = fileURLToPath(new URL("../dist", import.meta.url));

export function readFavicon(): string {
  return readFileSync(FAVICON_FILE_URL, "utf8");
}

export const clientBuildConfiguration = {
  cssCodeSplit: false,
  emptyOutDir: false,
  lib: {
    entry: fileURLToPath(new URL("../solid/client.tsx", import.meta.url)),
    fileName: () => "app.js",
    formats: ["es"],
  },
  minify: process.env.NODE_ENV === "production",
  outDir: OUT_DIRECTORY,
} satisfies BuildOptions;

export function createClientPlugins(): PluginOption[] {
  return [
    solid(),
    tailwindcss(),
    {
      generateBundle() {
        this.emitFile({
          fileName: FAVICON_PATH.slice(1),
          source: readFavicon(),
          type: "asset",
        });
      },
      name: "q-mush-favicon",
    },
  ];
}
