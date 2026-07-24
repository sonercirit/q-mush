import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import type { BuildOptions, ConfigEnv, PluginOption } from "vite";
import solid from "vite-plugin-solid";

export function createClientBuildConfiguration(
  nodeEnvironment = process.env.NODE_ENV,
): BuildOptions {
  return {
    cssCodeSplit: false,
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("../solid/client.tsx", import.meta.url)),
      fileName: () => "app.js",
      formats: ["es"],
    },
    minify: nodeEnvironment === "production",
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
  };
}

function serviceWorkerRegistrationEnabled(
  command: "build" | "serve",
  nodeEnvironment: string | undefined,
): boolean {
  return command === "build" && nodeEnvironment === "production";
}

export function createClientPlugins(
  nodeEnvironment = process.env.NODE_ENV,
): PluginOption[] {
  return [
    solid(),
    tailwindcss(),
    {
      config: (_, environment: ConfigEnv) => ({
        define: {
          "import.meta.env.PROD": JSON.stringify(
            serviceWorkerRegistrationEnabled(
              environment.command,
              nodeEnvironment,
            ),
          ),
        },
      }),
      name: "q-mush-production-flag",
    },
  ];
}
