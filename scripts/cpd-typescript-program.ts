import { join, resolve } from "node:path";
import {
  convertCompilerOptionsFromJson,
  createProgram,
  flattenDiagnosticMessageText,
  readConfigFile,
  sys,
  type CompilerOptions,
  type Program,
} from "typescript";

function readCompilerOptions(rootDirectory: string): CompilerOptions {
  const configPath = join(rootDirectory, "tsconfig.json");

  if (!sys.fileExists(configPath)) {
    return { allowJs: true, checkJs: false };
  }

  const result = readConfigFile(configPath, (path) => sys.readFile(path));
  if (result.error !== undefined) {
    throw new Error(
      `Could not read tsconfig.json: ${flattenDiagnosticMessageText(result.error.messageText, "\n")}`,
    );
  }

  const config: unknown = result.config;
  if (typeof config !== "object" || config === null) {
    throw new Error("Could not read compiler options from tsconfig.json.");
  }

  const compilerOptionsValue: unknown = Reflect.get(config, "compilerOptions");
  const converted = convertCompilerOptionsFromJson(
    typeof compilerOptionsValue === "object" && compilerOptionsValue !== null
      ? compilerOptionsValue
      : {},
    rootDirectory,
    configPath,
  );

  if (converted.errors.length > 0) {
    throw new Error(
      `Could not read compiler options: ${converted.errors
        .map((error) => flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n")}`,
    );
  }

  return {
    ...converted.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
  };
}

export function createCpdProgram(
  rootDirectory: string,
  relativePaths: readonly string[],
): Program {
  const absoluteRoot = resolve(rootDirectory);
  const options = readCompilerOptions(absoluteRoot);
  // TypeScript can parse these configured JavaScript extensions but keeps the
  // switch internal; enable it so the named-clone pass covers CPD's full map.
  Reflect.set(options, "allowNonTsExtensions", true);
  return createProgram({
    options,
    rootNames: relativePaths.map((path) => resolve(absoluteRoot, path)),
  });
}
