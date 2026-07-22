import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import type { BuildOptions, PluginOption } from "vite";
import solid from "vite-plugin-solid";

export const clientBuildConfiguration = {
  cssCodeSplit: false,
  emptyOutDir: false,
  lib: {
    entry: fileURLToPath(new URL("../solid/client.tsx", import.meta.url)),
    fileName: () => "app.js",
    formats: ["es"],
  },
  minify: process.env.NODE_ENV === "production",
  outDir: fileURLToPath(new URL("../dist", import.meta.url)),
} satisfies BuildOptions;

export function createClientPlugins(): PluginOption[] {
  return [solid(), tailwindcss()];
}
