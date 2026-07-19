import eslint from "@eslint/js";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const gitignorePath = fileURLToPath(new URL(".gitignore", import.meta.url));
const TSX_MIGRATION_MESSAGE = "Render and mount TSX instead.";

export default defineConfig(
  includeIgnoreFile(gitignorePath, { gitignoreResolution: true }),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
  },
  {
    files: ["**/*.{cts,mts,ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    // HTML-like text can be valid data, so restrict raw HTML sinks instead.
    files: ["src/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}"],
    ignores: ["src/**/fixtures/**", "src/**/test/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        { message: TSX_MIGRATION_MESSAGE, property: "innerHTML" },
        { message: TSX_MIGRATION_MESSAGE, property: "outerHTML" },
        { message: TSX_MIGRATION_MESSAGE, property: "insertAdjacentHTML" },
        {
          message: TSX_MIGRATION_MESSAGE,
          property: "createContextualFragment",
        },
        { message: TSX_MIGRATION_MESSAGE, property: "dangerouslySetInnerHTML" },
        { message: TSX_MIGRATION_MESSAGE, property: "setHTMLUnsafe" },
        { message: TSX_MIGRATION_MESSAGE, property: "srcdoc" },
        {
          message: TSX_MIGRATION_MESSAGE,
          object: "document",
          property: "write",
        },
        {
          message: TSX_MIGRATION_MESSAGE,
          object: "document",
          property: "writeln",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          message:
            "Do not pass an HTML-like string to Response. Render TSX instead.",
          selector:
            'NewExpression[callee.name="Response"] > Literal[value=/<[A-Za-z!]/i]',
        },
        {
          message:
            "Do not pass an HTML-like template to Response. Render TSX instead.",
          selector:
            'NewExpression[callee.name="Response"] TemplateElement[value.raw=/<[A-Za-z!]/i]',
        },
        {
          message:
            "Do not inject HTML through JSX attributes. Render TSX instead.",
          selector:
            "JSXAttribute[name.name=/^(?:dangerouslySetInnerHTML|src[Dd]oc)$/]",
        },
      ],
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ["**/*.{cjs,js,mjs}"],
  },
);
