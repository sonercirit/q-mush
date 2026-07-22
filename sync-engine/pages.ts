import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";
import solid from "vite-plugin-solid";

export interface RenderedPages {
  readonly app: string;
  readonly home: string;
}

interface PageModule {
  renderAppPage(): string;
  renderHomePage(): string;
}

export async function renderPages(): Promise<RenderedPages> {
  const entrypoint = fileURLToPath(
    new URL("../solid/pages.tsx", import.meta.url),
  );
  const { module } = await runnerImport<PageModule>(entrypoint, {
    configFile: false,
    logLevel: "silent",
    plugins: [solid({ hot: false, solid: { hydratable: false }, ssr: true })],
    root: fileURLToPath(new URL("..", import.meta.url)),
  });

  return {
    app: module.renderAppPage(),
    home: module.renderHomePage(),
  };
}
