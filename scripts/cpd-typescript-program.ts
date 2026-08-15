import { join, resolve } from "node:path";
import {
  createCompilerHost,
  createProgram,
  createSourceFile,
  flattenDiagnosticMessageText,
  parseJsonConfigFileContent,
  readConfigFile,
  ScriptKind,
  sys,
  type CompilerOptions,
  type Diagnostic,
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

  const parsed = parseJsonConfigFileContent(
    config,
    sys,
    rootDirectory,
    undefined,
    configPath,
  );

  if (parsed.errors.length > 0) {
    throw new Error(
      `Could not read compiler options: ${parsed.errors
        .map((error) => flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n")}`,
    );
  }

  return {
    ...parsed.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
  };
}

function diagnosticText(diagnostic: Diagnostic): string {
  const message = flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return message;
  }
  const location = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return `${diagnostic.file.fileName}:${String(location.line + 1)}:${String(location.character + 1)} - ${message}`;
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
  const defaultHost = createCompilerHost(options);
  const sourcePathSet = new Set(
    relativePaths.map((path) => resolve(absoluteRoot, path)),
  );
  const program = createProgram({
    host: {
      ...defaultHost,
      getSourceFile: (fileName, languageVersion, onError) => {
        if (sourcePathSet.has(resolve(fileName))) {
          const text = defaultHost.readFile(fileName);
          return text === undefined
            ? undefined
            : createSourceFile(
                fileName,
                text,
                languageVersion,
                true,
                ScriptKind.TSX,
              );
        }
        return defaultHost.getSourceFile(fileName, languageVersion, onError);
      },
    },
    options,
    rootNames: [...sourcePathSet],
  });
  const diagnostics = program.getSyntacticDiagnostics();
  if (diagnostics.length > 0) {
    throw new Error(
      `TypeScript could not analyze CPD sources:\n${diagnostics
        .map(diagnosticText)
        .join("\n")}`,
    );
  }
  return program;
}
