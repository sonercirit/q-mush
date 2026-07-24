import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { expect, test } from "vitest";
import { FAVICON_PATH } from "../../shared/routes.ts";
import {
  clientBuildConfiguration,
  createClientPlugins,
  readFavicon,
} from "../../sync-engine/client-build.ts";

test("emits the exact favicon with production browser assets", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "q-mush-client-build-"));
  const faviconFile = join(outputDirectory, FAVICON_PATH.slice(1));

  try {
    await build({
      build: {
        ...clientBuildConfiguration,
        minify: true,
        outDir: outputDirectory,
      },
      configFile: false,
      logLevel: "silent",
      plugins: createClientPlugins(),
    });

    expect(await Bun.file(faviconFile).text()).toBe(readFavicon());
    expect(await Bun.file(join(outputDirectory, "favicon.ico")).exists()).toBe(
      false,
    );
  } finally {
    await rm(outputDirectory, { recursive: true });
  }
});
