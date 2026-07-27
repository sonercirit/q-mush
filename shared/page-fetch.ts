export const PAGE_FETCH_TOOL_NAME = "page_fetch";

export const PAGE_FETCH_TOOL_DEFINITION = {
  function: {
    description: "Fetch browser-rendered content from a public URL.",
    name: PAGE_FETCH_TOOL_NAME,
    parameters: {
      additionalProperties: false,
      properties: {
        timeout: { maximum: 120, minimum: 1, type: "number" },
        url: { type: "string" },
      },
      required: ["url"],
      type: "object",
    },
  },
  type: "function",
} as const;
