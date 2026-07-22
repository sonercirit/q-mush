import { defineConfig } from "vite";
import {
  clientBuildConfiguration,
  createClientPlugins,
} from "./sync-engine/client-build.ts";

export default defineConfig({
  build: clientBuildConfiguration,
  plugins: createClientPlugins(),
});
