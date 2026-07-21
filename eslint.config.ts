import eslint from "@eslint/js";
import type { Rule } from "eslint";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import { fileURLToPath } from "node:url";
import { configs } from "typescript-eslint";

const gitignorePath = fileURLToPath(new URL(".gitignore", import.meta.url));
const TSX_MIGRATION_MESSAGE = "Render and mount TSX instead.";

const canonicalImportsRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Require canonical named imports",
    },
    messages: {
      alias: "Import the exported name without an alias.",
      attributes: "Import attributes are forbidden.",
      default:
        "Default imports are forbidden except for default-only dependencies.",
      dynamic: "Dynamic imports are forbidden; use a static named import.",
      importEquals: "Import-equals declarations are forbidden.",
      importType: "Import the named type instead of using import() types.",
      namespace: "Import the required names instead of the module namespace.",
      sideEffect: "Importing a module only for side effects is forbidden.",
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.attributes.length > 0) {
          context.report({ messageId: "attributes", node });
        }

        if (node.specifiers.length === 0) {
          context.report({ messageId: "sideEffect", node });
        }

        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportDefaultSpecifier" &&
            node.source.value !== "@eslint/js"
          ) {
            context.report({ messageId: "default", node: specifier });
          }
        }
      },
      ImportExpression(node) {
        context.report({ messageId: "dynamic", node });
      },
      ImportNamespaceSpecifier(node) {
        context.report({ messageId: "namespace", node });
      },
      ImportSpecifier(node) {
        const usesAlias = context.sourceCode
          .getTokens(node)
          .some((token) => token.value === "as");

        if (usesAlias) {
          context.report({ messageId: "alias", node });
        }
      },
      TSImportEqualsDeclaration(node: Rule.Node) {
        context.report({ messageId: "importEquals", node });
      },
      TSImportType(node: Rule.Node) {
        context.report({ messageId: "importType", node });
      },
    };
  },
};

export default defineConfig(
  includeIgnoreFile(gitignorePath, { gitignoreResolution: true }),
  eslint.configs.recommended,
  configs.strictTypeChecked,
  configs.stylisticTypeChecked,
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
    plugins: {
      "q-mush": {
        rules: { "canonical-imports": canonicalImportsRule },
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: false }],
      "q-mush/canonical-imports": "error",
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
    ...configs.disableTypeChecked,
    files: ["**/*.{cjs,js,mjs}"],
  },
);
