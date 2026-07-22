import type { AgentImage } from "../../shared/agent-images.ts";

const TEST_MEDIA_TYPE = "image/png";
const PIXEL_BYTES = [
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC",
  "AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
];

export const TEST_AGENT_IMAGE: AgentImage = Object.freeze({
  data: PIXEL_BYTES.join(""),
  mediaType: TEST_MEDIA_TYPE,
  name: "pixel.png",
});
