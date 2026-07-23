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

function serviceWorkerRegistrationEnabled(
  command: "build" | "serve",
  nodeEnvironment: string | undefined,
): boolean {
  return command === "build" && nodeEnvironment === "production";
}

export function createClientPlugins(): PluginOption[] {
  return [
    solid(),
    tailwindcss(),
    {
      config: (_, environment) => ({
        define: {
          "import.meta.env.PROD": JSON.stringify(
            serviceWorkerRegistrationEnabled(
              environment.command,
              process.env.NODE_ENV,
            ),
          ),
        },
        name: "q-mush-production-flag",
      }),
      name: "q-mush-production-flag",
    },
  ];
}
