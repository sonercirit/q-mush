const ADDITIVE_TOOL_BLOCK = {
  caller: { type: "direct" },
  future_tool_field: { token: "opaque" },
  id: "call-additive",
  input: { path: "additive-provider-field.md" },
  name: "read_additive_field",
  type: "tool_use" as const,
};

export function additiveReplayBlocks() {
  return [
    {
      signature: "signed-thinking",
      thinking: "Inspect.",
      type: "thinking" as const,
      vendor_metadata: { revision: 2 },
    },
    {
      future_text_field: ["opaque", { enabled: true }],
      text: "Ready.",
      type: "text" as const,
    },
    ADDITIVE_TOOL_BLOCK,
  ] as const;
}
