import { build } from "vite";
import { sha256 } from "../shared/sha256.ts";
import {
  clientBuildConfiguration,
  createClientPlugins,
} from "./client-build.ts";

interface ViteClientAssets {
  readonly javaScript: string;
  readonly stylesheet: string;
}

interface ClientReleaseManifest {
  readonly files: Readonly<Record<string, string>>;
  readonly version: 1;
}

export interface ClientRelease {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly manifest: ClientReleaseManifest;
}

function isViteOutput(
  value: Awaited<ReturnType<typeof build>>,
): value is Extract<Awaited<ReturnType<typeof build>>, { output: unknown }> {
  return !Array.isArray(value) && "output" in value;
}

function viteOutputs(
  result: Awaited<ReturnType<typeof build>>,
): readonly Extract<Awaited<ReturnType<typeof build>>, { output: unknown }>[] {
  return Array.isArray(result)
    ? result.filter(isViteOutput)
    : isViteOutput(result)
      ? [result]
      : [];
}

function readViteClientAssets(
  result: Awaited<ReturnType<typeof build>>,
): ViteClientAssets {
  const builds = viteOutputs(result);
  if (builds.length === 0) {
    throw new Error("The Vite browser build did not return output");
  }
  let javaScript: string | undefined;
  let stylesheet: string | undefined;
  for (const { output: outputs } of builds) {
    for (const output of outputs) {
      if (output.type === "chunk" && output.isEntry) {
        javaScript = output.code;
      } else if (output.type === "asset" && output.fileName.endsWith(".css")) {
        stylesheet =
          typeof output.source === "string"
            ? output.source
            : new TextDecoder().decode(output.source);
      }
    }
  }
  if (javaScript === undefined || stylesheet === undefined) {
    throw new Error(
      "The Vite browser build did not produce JavaScript and CSS",
    );
  }
  return { javaScript, stylesheet };
}

let clientAssets: Promise<ViteClientAssets> | undefined;

function buildClientAssets(): Promise<ViteClientAssets> {
  clientAssets ??= build({
    build: { ...clientBuildConfiguration, write: false },
    configFile: false,
    logLevel: "silent",
    plugins: createClientPlugins(),
  }).then(readViteClientAssets);
  return clientAssets;
}

export async function buildClientRelease(): Promise<ClientRelease> {
  const assets = await buildClientAssets();
  const encoder = new TextEncoder();
  const javaScript = encoder.encode(assets.javaScript);
  const stylesheet = encoder.encode(assets.stylesheet);
  const assetFiles = {
    [`app.${sha256(javaScript)}.js`]: javaScript,
    [`styles.${sha256(stylesheet)}.css`]: stylesheet,
  };
  const manifest: ClientReleaseManifest = {
    files: Object.fromEntries(
      Object.entries(assetFiles).map(([name, bytes]) => [name, sha256(bytes)]),
    ),
    version: 1,
  };
  return {
    files: {
      ...assetFiles,
      "manifest.json": encoder.encode(JSON.stringify(manifest)),
    },
    manifest,
  };
}

export async function buildClientStylesheet(): Promise<string> {
  return (await buildClientAssets()).stylesheet;
}

export async function buildClientJavaScript(): Promise<string> {
  return (await buildClientAssets()).javaScript;
}
