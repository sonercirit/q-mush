import {
  APP_PATH,
  PWA_ICON_192_PATH,
  PWA_ICON_512_MASKABLE_PATH,
  PWA_ICON_512_PATH,
} from "./routes.ts";

export const PWA_BACKGROUND_COLOR = "#020617";
export const PWA_THEME_COLOR = "#020617";

interface PwaManifestIcon {
  readonly purpose: "any" | "maskable";
  readonly sizes: string;
  readonly src: string;
  readonly type: "image/png";
}

export interface PwaManifest {
  readonly background_color: string;
  readonly description: string;
  readonly display: "standalone";
  readonly icons: readonly PwaManifestIcon[];
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly short_name: string;
  readonly start_url: string;
  readonly theme_color: string;
}

export const PWA_MANIFEST: PwaManifest = {
  background_color: PWA_BACKGROUND_COLOR,
  description: "A local-first distributed agent swarm harness.",
  display: "standalone",
  icons: [
    {
      purpose: "any",
      sizes: "192x192",
      src: PWA_ICON_192_PATH,
      type: "image/png",
    },
    {
      purpose: "any",
      sizes: "512x512",
      src: PWA_ICON_512_PATH,
      type: "image/png",
    },
    {
      purpose: "maskable",
      sizes: "512x512",
      src: PWA_ICON_512_MASKABLE_PATH,
      type: "image/png",
    },
  ],
  id: APP_PATH,
  name: "Q Mush",
  scope: "/",
  short_name: "Q Mush",
  start_url: APP_PATH,
  theme_color: PWA_THEME_COLOR,
};
