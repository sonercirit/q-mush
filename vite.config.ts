import { defineConfig } from "vite";
import {
  createClientBuildConfiguration,
  createClientPlugins,
} from "./sync-engine/client-build.ts";

export default defineConfig({
  build: createClientBuildConfiguration(),
  plugins: createClientPlugins(),
});
