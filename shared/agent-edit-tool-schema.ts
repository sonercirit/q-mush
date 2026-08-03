export const EDIT_REPLACEMENT_PARAMETER = {
  additionalProperties: false,
  properties: {
    newText: {
      description: "Replacement text for this targeted edit.",
      type: "string",
    },
    oldText: {
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
      type: "string",
    },
  },
  required: ["oldText", "newText"],
  type: "object",
} as const;
