import eslint from "@eslint/js";
import type { ESLint, Rule } from "eslint";
import solidPlugin from "eslint-plugin-solid";
import solidRecommended from "eslint-plugin-solid/configs/recommended";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { configs } from "typescript-eslint";

const gitignorePath = fileURLToPath(new URL(".gitignore", import.meta.url));
const ROOT_DIRECTORY = dirname(gitignorePath);
const ALLOWED_SIDE_EFFECT_IMPORTS = new Set(["./styles.css", "../styles.css"]);
const APPLICATION_WORKSPACES = new Set([
  "runner",
  "shared",
  "solid",
  "sync-engine",
]);
const DEFAULT_ONLY_DEPENDENCIES = new Set([
  "@eslint/js",
  "@tailwindcss/vite",
  "eslint-plugin-solid",
  "eslint-plugin-solid/configs/recommended",
  "vite-plugin-solid",
]);
const TSX_MIGRATION_MESSAGE = "Render and mount TSX instead.";
const INLINE_CONFIGURATION_MESSAGE =
  "Inline ESLint configuration is forbidden; fix the violation instead.";
const ESLINT_DIRECTIVE_PATTERN =
  /^\s*eslint-(?:disable|enable)(?:-line|-next-line)?(?:\s|$)/u;
const RESTRICTED_TYPESCRIPT_SYNTAX = [
  {
    message:
      "Switch statements are forbidden; use data-driven dispatch or conditionals.",
    selector: "SwitchStatement",
  },
  {
    message:
      "Class declarations are forbidden; use functions and plain objects.",
    selector: "ClassDeclaration",
  },
  {
    message:
      "Class expressions are forbidden; use functions and plain objects.",
    selector: "ClassExpression",
  },
];

function workspaceForPath(path: string): string | undefined {
  const [workspace] = relative(ROOT_DIRECTORY, path).split(sep);
  return workspace !== undefined && APPLICATION_WORKSPACES.has(workspace)
    ? workspace
    : workspace === "scripts"
      ? workspace
      : undefined;
}

function reportImportBoundary(
  context: Rule.RuleContext,
  node: Rule.Node,
  source: string,
): void {
  if (!source.startsWith(".")) {
    return;
  }

  const importerWorkspace = workspaceForPath(context.filename);
  const targetWorkspace = workspaceForPath(
    resolve(dirname(context.filename), source),
  );

  if (targetWorkspace === "scripts" && importerWorkspace !== "scripts") {
    context.report({ messageId: "scripts", node });
    return;
  }

  if (
    importerWorkspace === undefined ||
    targetWorkspace === importerWorkspace ||
    importerWorkspace === "scripts"
  ) {
    return;
  }

  if (targetWorkspace === undefined) {
    context.report({ messageId: "workspace", node });
    return;
  }

  if (targetWorkspace !== "shared") {
    context.report({ messageId: "workspace", node });
  }
}

function reportImportSource(
  context: Rule.RuleContext,
  node: Rule.Node,
  source: { readonly value?: unknown } | null | undefined,
): void {
  if (source !== undefined && source !== null) {
    reportImportBoundary(context, node, String(source.value));
  }
}

const inlineConfigurationRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid inline ESLint configuration directives",
    },
    messages: {
      forbidden: INLINE_CONFIGURATION_MESSAGE,
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (ESLINT_DIRECTIVE_PATTERN.test(comment.value)) {
            context.report({ messageId: "forbidden", node: comment });
          }
        }
      },
    };
  },
};

const importBoundariesRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Enforce top-level workspace import boundaries",
    },
    messages: {
      scripts: "Importing from scripts is forbidden outside scripts.",
      workspace: "Import only within this workspace or from shared.",
    },
    schema: [],
  },
  create(context) {
    return {
      ExportAllDeclaration(node) {
        reportImportSource(context, node, node.source);
      },
      ExportNamedDeclaration(node) {
        reportImportSource(context, node, node.source);
      },
      ImportDeclaration(node) {
        reportImportSource(context, node, node.source);
      },
    };
  },
};

const propsObjectSpreadRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow snapshotting Solid component props with spread",
    },
    messages: {
      snapshot:
        "Spreading component props into an object snapshots reactive values; pass props or reactive accessors directly.",
    },
    schema: [],
  },
  create(context) {
    return {
      ObjectExpression(node) {
        for (const property of node.properties) {
          if (
            property.type === "SpreadElement" &&
            property.argument.type === "Identifier" &&
            property.argument.name === "props"
          ) {
            context.report({ messageId: "snapshot", node: property });
          }
        }
      },
    };
  },
};

function eslintPluginIsCompatible(plugin: unknown): plugin is ESLint.Plugin {
  return typeof plugin === "object" && plugin !== null && "rules" in plugin;
}

if (!eslintPluginIsCompatible(solidPlugin)) {
  throw new TypeError("eslint-plugin-solid did not export an ESLint plugin");
}

// The package supports TypeScript 6 and works under ESLint 10, but its published
// peer range and rule types currently stop at ESLint 9. Narrow the runtime
// export before composing its recommended flat config with ESLint 10's types.
const solidConfig = {
  ...solidRecommended,
  plugins: { solid: solidPlugin },
};

function canonicalImportSource(node: {
  readonly source: { readonly value?: unknown };
}): string {
  return String(node.source.value);
}

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

        if (
          node.specifiers.length === 0 &&
          !ALLOWED_SIDE_EFFECT_IMPORTS.has(canonicalImportSource(node))
        ) {
          context.report({ messageId: "sideEffect", node });
        }

        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportDefaultSpecifier" &&
            !DEFAULT_ONLY_DEPENDENCIES.has(canonicalImportSource(node))
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
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
    plugins: {
      "q-mush": {
        rules: {
          "canonical-imports": canonicalImportsRule,
          "import-boundaries": importBoundariesRule,
          "no-inline-configuration": inlineConfigurationRule,
          "no-props-object-spread": propsObjectSpreadRule,
        },
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-expect-error": true,
          "ts-ignore": true,
          "ts-nocheck": true,
        },
      ],
      "q-mush/no-inline-configuration": "error",
    },
  },
  {
    files: ["**/*.{cts,mts,ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: false }],
      "no-restricted-syntax": ["error", ...RESTRICTED_TYPESCRIPT_SYNTAX],
      "q-mush/canonical-imports": "error",
      "q-mush/import-boundaries": "error",
    },
  },
  {
    files: ["solid/**/*.tsx"],
    ...solidConfig,
    rules: {
      ...solidConfig.rules,
      // Recommended marks some runtime-safety rules as advisory; this project
      // treats every finding as an error so CI cannot admit reactivity bugs.
      "solid/components-return-once": "error",
      "solid/event-handlers": "error",
      "solid/imports": "error",
      "solid/no-react-deps": "error",
      "solid/no-react-specific-props": "error",
      "solid/reactivity": [
        "error",
        {
          customReactiveFunctions: [
            "checkedInputHandler",
            "choiceInputHandler",
            "insertSelected",
            "queueMicrotask",
            "renderWithWorkspaces",
            "restoreDialogFocus",
            "submitFormName",
          ],
        },
      ],
      "solid/self-closing-comp": "error",
      "solid/style-prop": "error",
      "q-mush/no-props-object-spread": "error",
    },
  },
  {
    // HTML-like text can be valid data, so restrict raw HTML sinks instead.
    files: [
      "runner/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
      "scripts/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
      "shared/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
      "solid/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
      "sync-engine/**/*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
    ],
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
        ...RESTRICTED_TYPESCRIPT_SYNTAX,
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
