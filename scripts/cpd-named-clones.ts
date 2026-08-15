import { resolve } from "node:path";
import {
  forEachChild,
  isFunctionLike,
  isIdentifier,
  isPrivateIdentifier,
  SyntaxKind,
  type Node,
  type SourceFile,
  type Symbol,
  type TypeChecker,
} from "typescript";
import { createCpdProgram } from "./cpd-typescript-program.ts";

interface CloneLocation {
  readonly column: number;
  readonly line: number;
}

interface NamedCloneFragment {
  readonly end: CloneLocation;
  readonly path: string;
  readonly start: CloneLocation;
}

export interface NamedClone {
  readonly first: NamedCloneFragment;
  readonly second: NamedCloneFragment;
  readonly tokens: number;
}

interface FunctionOccurrence extends NamedCloneFragment {
  readonly fingerprint: string;
  readonly originalFingerprint: string;
  readonly tokens: number;
}

interface TokenFingerprints {
  readonly normalized: string;
  readonly original: string;
  readonly tokens: number;
}

function symbolIsBoundWithin(
  symbol: Symbol,
  functionNode: Node,
  sourceFile: SourceFile,
): boolean {
  const functionStart = functionNode.getStart(sourceFile);
  const functionEnd = functionNode.getEnd();
  return (
    symbol.declarations?.some(
      (declaration) =>
        declaration.getSourceFile() === sourceFile &&
        declaration.getStart(sourceFile) >= functionStart &&
        declaration.getEnd() <= functionEnd,
    ) === true
  );
}

function tokenFingerprints(
  functionNode: Node,
  sourceFile: SourceFile,
  checker: TypeChecker,
): TokenFingerprints {
  const normalized: string[] = [];
  const original: string[] = [];
  const canonicalNames = new Map<Symbol, string>();

  function visit(node: Node): void {
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (const child of children) {
        visit(child);
      }
      return;
    }

    if (node.kind === SyntaxKind.EndOfFileToken) {
      return;
    }

    const text = node.getText(sourceFile);
    let normalizedText = text;

    if (isIdentifier(node) || isPrivateIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (
        symbol !== undefined &&
        symbolIsBoundWithin(symbol, functionNode, sourceFile)
      ) {
        let canonical = canonicalNames.get(symbol);
        if (canonical === undefined) {
          canonical = `owned${String(canonicalNames.size)}`;
          canonicalNames.set(symbol, canonical);
        }
        normalizedText = isPrivateIdentifier(node)
          ? `#${canonical}`
          : canonical;
      }
    }

    original.push(`${String(node.kind)}:${text}`);
    normalized.push(`${String(node.kind)}:${normalizedText}`);
  }

  visit(functionNode);
  return {
    normalized: JSON.stringify(normalized),
    original: JSON.stringify(original),
    tokens: normalized.length,
  };
}

function functionNodes(sourceFile: SourceFile): Node[] {
  const functions: Node[] = [];

  function visit(node: Node): void {
    if (isFunctionLike(node) && "body" in node && node.body !== undefined) {
      functions.push(node);
    }
    forEachChild(node, visit);
  }

  visit(sourceFile);
  return functions;
}

function location(sourceFile: SourceFile, position: number): CloneLocation {
  const value = sourceFile.getLineAndCharacterOfPosition(position);
  return { column: value.character + 1, line: value.line + 1 };
}

function occurrencesInSource(
  path: string,
  sourceFile: SourceFile,
  checker: TypeChecker,
  minLines: number,
  minTokens: number,
): FunctionOccurrence[] {
  return functionNodes(sourceFile).flatMap((node) => {
    const fingerprints = tokenFingerprints(node, sourceFile, checker);
    const start = location(sourceFile, node.getStart(sourceFile));
    const end = location(sourceFile, node.getEnd());

    return fingerprints.tokens >= minTokens && end.line - start.line >= minLines
      ? [
          {
            end,
            fingerprint: fingerprints.normalized,
            originalFingerprint: fingerprints.original,
            path,
            start,
            tokens: fingerprints.tokens,
          },
        ]
      : [];
  });
}

export function findNamedClones(
  rootDirectory: string,
  sourcePaths: readonly string[],
  minLines: number,
  minTokens: number,
): NamedClone[] {
  const program = createCpdProgram(rootDirectory, sourcePaths);
  const checker = program.getTypeChecker();
  const sourceFilesByPath = new Map(
    program
      .getSourceFiles()
      .map((sourceFile) => [resolve(sourceFile.fileName), sourceFile] as const),
  );
  const groups = new Map<string, FunctionOccurrence[]>();

  for (const path of sourcePaths) {
    const sourceFile = sourceFilesByPath.get(resolve(rootDirectory, path));
    if (sourceFile === undefined) {
      throw new Error(`TypeScript could not parse ${path}.`);
    }

    for (const occurrence of occurrencesInSource(
      path,
      sourceFile,
      checker,
      minLines,
      minTokens,
    )) {
      const group = groups.get(occurrence.fingerprint);
      if (group === undefined) {
        groups.set(occurrence.fingerprint, [occurrence]);
      } else {
        group.push(occurrence);
      }
    }
  }

  const clones: NamedClone[] = [];

  for (const occurrences of groups.values()) {
    for (const [index, second] of occurrences.entries()) {
      const first = occurrences
        .slice(0, index)
        .find(
          (candidate) =>
            candidate.originalFingerprint !== second.originalFingerprint,
        );
      if (first !== undefined) {
        clones.push({ first, second, tokens: second.tokens });
      }
    }
  }

  return clones;
}

export function formatNamedClones(clones: readonly NamedClone[]): string {
  if (clones.length === 0) {
    return "Found 0 clones with renamed local bindings.";
  }

  return [
    ...clones.flatMap(({ first, second, tokens }) => [
      "Clone found after normalizing locally bound names (tsx)",
      ` - ${first.path} [${String(first.start.line)}:${String(first.start.column)} - ${String(first.end.line)}:${String(first.end.column)}] (${String(tokens)} tokens)`,
      `   ${second.path} [${String(second.start.line)}:${String(second.start.column)} - ${String(second.end.line)}:${String(second.end.column)}]`,
    ]),
    `Found ${String(clones.length)} clones with renamed local bindings.`,
  ].join("\n");
}
