import { parse } from "@typescript-eslint/typescript-estree";
import { extname, resolve } from "node:path";
import {
  forEachChild,
  isArrowFunction,
  isBindingElement,
  isBreakStatement,
  isClassLike,
  isContinueStatement,
  isEnumMember,
  isFunctionLike,
  isIdentifier,
  isJsxAttribute,
  isLabeledStatement,
  isObjectBindingPattern,
  isObjectLiteralElementLike,
  isParameterPropertyDeclaration,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isQualifiedName,
  isShorthandPropertyAssignment,
  isTypeElement,
  SyntaxKind,
  type NamedDeclaration,
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
  readonly endPosition: number;
  readonly fingerprint: string;
  readonly originalFingerprint: string;
  readonly startPosition: number;
  readonly tokens: number;
}

interface CloneOccurrence extends NamedClone {
  readonly first: FunctionOccurrence;
  readonly second: FunctionOccurrence;
}

interface FingerprintToken {
  readonly binding: Node | Symbol | undefined;
  readonly isPrivate: boolean;
  readonly kind: SyntaxKind;
  readonly position: number;
  readonly propertyName: boolean;
  readonly symbol: Symbol | undefined;
  readonly text: string;
}

interface TokenFingerprints {
  readonly normalized: string;
  readonly original: string;
}

interface SourceFingerprint {
  readonly positions: readonly number[];
  readonly splitArrowStarts: ReadonlySet<number>;
  readonly tokens: readonly FingerprintToken[];
}

interface SourceTokens {
  readonly fingerprint: readonly FingerprintToken[];
  readonly fingerprintPositions: readonly number[];
  readonly nativeStarts: readonly number[];
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

function namedDeclarationHasName(
  node: Node,
  name: Node,
): node is NamedDeclaration {
  return "name" in node && node.name === name;
}

function propertyNameRemainsSignificant(node: Node): boolean {
  if (!isIdentifier(node) && !isPrivateIdentifier(node)) {
    return false;
  }

  const parent = node.parent;
  if (
    (isPropertyAccessExpression(parent) && parent.name === node) ||
    (isBindingElement(parent) &&
      isObjectBindingPattern(parent.parent) &&
      (parent.propertyName === node ||
        (parent.propertyName === undefined &&
          parent.dotDotDotToken === undefined &&
          parent.name === node))) ||
    (isParameterPropertyDeclaration(parent, parent.parent) &&
      parent.name === node) ||
    (isEnumMember(parent) && parent.name === node) ||
    (isJsxAttribute(parent) && parent.name === node) ||
    (isQualifiedName(parent) && parent.right === node) ||
    (namedDeclarationHasName(parent, node) &&
      (isObjectLiteralElementLike(parent) ||
        isTypeElement(parent) ||
        isClassLike(parent.parent)))
  ) {
    return true;
  }

  return (
    isIdentifier(node) &&
    isShorthandPropertyAssignment(parent) &&
    parent.name === node
  );
}

function labelDeclaration(node: Node): Node | undefined {
  if (!isIdentifier(node)) {
    return undefined;
  }

  const parent = node.parent;
  if (isLabeledStatement(parent) && parent.label === node) {
    return node;
  }
  if (!isBreakStatement(parent) && !isContinueStatement(parent)) {
    return undefined;
  }

  let ancestor = parent.parent;
  while (!isFunctionLike(ancestor)) {
    if (isLabeledStatement(ancestor) && ancestor.label.text === node.text) {
      return ancestor.label;
    }
    ancestor = ancestor.parent;
  }
  return undefined;
}

function sourceFingerprintTokens(
  sourceFile: SourceFile,
  checker: TypeChecker,
): SourceFingerprint {
  const positions: number[] = [];
  const splitArrowStarts = new Set<number>();
  const tokens: FingerprintToken[] = [];

  function visit(node: Node): void {
    if (isArrowFunction(node)) {
      const typeParameters = node.typeParameters;
      if (typeParameters?.length === 1) {
        const parameter = typeParameters[0];
        if (
          parameter !== undefined &&
          parameter.constraint === undefined &&
          parameter.default === undefined &&
          !typeParameters.hasTrailingComma
        ) {
          splitArrowStarts.add(
            node.equalsGreaterThanToken.getStart(sourceFile),
          );
        }
      }
    }

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

    const identifier = isIdentifier(node) || isPrivateIdentifier(node);
    const propertyName = identifier && propertyNameRemainsSignificant(node);
    const symbol =
      identifier && !propertyName
        ? checker.getSymbolAtLocation(node)
        : undefined;
    positions.push(node.getStart(sourceFile));
    tokens.push({
      binding: labelDeclaration(node) ?? symbol,
      isPrivate: isPrivateIdentifier(node),
      kind: node.kind,
      position: node.getStart(sourceFile),
      propertyName,
      symbol,
      text: node.getText(sourceFile),
    });
  }

  visit(sourceFile);
  return { positions, splitArrowStarts, tokens };
}

function tokenFingerprints(
  functionNode: Node,
  sourceFile: SourceFile,
  tokens: readonly FingerprintToken[],
  tokenPositions: readonly number[],
): TokenFingerprints {
  const normalized: string[] = [];
  const original: string[] = [];
  const canonicalNames = new Map<Node | Symbol, string>();
  const freeSymbols = new Set<Symbol>();
  const startIndex = firstIndexAtLeast(
    tokenPositions,
    functionNode.getStart(sourceFile),
  );
  const end = functionNode.getEnd();

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.position >= end) {
      break;
    }

    let normalizedText = token.text;
    const symbol = token.symbol;
    if (
      token.binding !== undefined &&
      !token.propertyName &&
      (symbol === undefined || !freeSymbols.has(symbol))
    ) {
      let canonical = canonicalNames.get(token.binding);
      if (canonical === undefined) {
        if (
          symbol !== undefined &&
          token.binding === symbol &&
          !symbolIsBoundWithin(symbol, functionNode, sourceFile)
        ) {
          freeSymbols.add(symbol);
        } else {
          canonical = `owned${String(canonicalNames.size)}`;
          canonicalNames.set(token.binding, canonical);
        }
      }
      if (canonical !== undefined) {
        normalizedText = token.isPrivate ? `#${canonical}` : canonical;
      }
    }

    original.push(`${String(token.kind)}:${token.text}`);
    normalized.push(`${String(token.kind)}:${normalizedText}`);
  }

  return {
    normalized: JSON.stringify(normalized),
    original: JSON.stringify(original),
  };
}

function parserFilePath(path: string): string {
  const extension = extname(path).toLowerCase();
  return /^(?:\.cts|\.mts|\.ts)$/u.test(extension) ? "source.ts" : "source.tsx";
}

function sourceTokens(
  path: string,
  sourceFile: SourceFile,
  checker: TypeChecker,
): SourceTokens {
  const parsed = parse(sourceFile.text, {
    filePath: parserFilePath(path),
    range: true,
    tokens: true,
  });
  const fingerprint = sourceFingerprintTokens(sourceFile, checker);
  const nativeStarts: number[] = [];

  for (const token of parsed.tokens) {
    const tokenCopies =
      token.value === "=>" && fingerprint.splitArrowStarts.has(token.range[0])
        ? 2
        : 1;
    nativeStarts.push(
      ...Array.from({ length: tokenCopies }, () => token.range[0]),
    );
  }
  return {
    fingerprint: fingerprint.tokens,
    fingerprintPositions: fingerprint.positions,
    nativeStarts,
  };
}

function firstIndexAtLeast(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = values[middle];
    if (value !== undefined && value < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function nativeTokenCount(
  node: Node,
  sourceFile: SourceFile,
  tokens: SourceTokens,
): number {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  return (
    firstIndexAtLeast(tokens.nativeStarts, end) -
    firstIndexAtLeast(tokens.nativeStarts, start)
  );
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

function functionSpansMinimumLines(
  sourceFile: SourceFile,
  node: Node,
  minLines: number,
): boolean {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return end.line - start.line >= minLines;
}

function occurrencesInSource(
  path: string,
  sourceFile: SourceFile,
  checker: TypeChecker,
  minLines: number,
  minTokens: number,
): FunctionOccurrence[] {
  const tokens = sourceTokens(path, sourceFile, checker);
  return functionNodes(sourceFile).flatMap((node) => {
    const tokenCount = nativeTokenCount(node, sourceFile, tokens);
    if (
      tokenCount < minTokens ||
      !functionSpansMinimumLines(sourceFile, node, minLines)
    ) {
      return [];
    }
    const fingerprints = tokenFingerprints(
      node,
      sourceFile,
      tokens.fingerprint,
      tokens.fingerprintPositions,
    );
    return [
      {
        end: location(sourceFile, node.getEnd()),
        endPosition: node.getEnd(),
        fingerprint: fingerprints.normalized,
        originalFingerprint: fingerprints.original,
        path,
        start: location(sourceFile, node.getStart(sourceFile)),
        startPosition: node.getStart(sourceFile),
        tokens: tokenCount,
      },
    ];
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

  const clones: CloneOccurrence[] = [];

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

  return clones.filter(
    ({ first, second }) =>
      !clones.some(
        (candidate) =>
          candidate.first.path === first.path &&
          candidate.first.startPosition <= first.startPosition &&
          candidate.first.endPosition >= first.endPosition &&
          candidate.second.path === second.path &&
          candidate.second.startPosition <= second.startPosition &&
          candidate.second.endPosition >= second.endPosition &&
          (candidate.first.startPosition < first.startPosition ||
            candidate.first.endPosition > first.endPosition ||
            candidate.second.startPosition < second.startPosition ||
            candidate.second.endPosition > second.endPosition),
      ),
  );
}

export function formatNamedClones(clones: readonly NamedClone[]): string {
  if (clones.length === 0) {
    return "Found 0 clones with renamed local bindings.";
  }

  return [
    ...clones.flatMap(({ first, second, tokens }) => [
      "Clone found after normalizing locally bound names",
      ` - ${first.path} [${String(first.start.line)}:${String(first.start.column)} - ${String(first.end.line)}:${String(first.end.column)}] (${String(tokens)} tokens)`,
      `   ${second.path} [${String(second.start.line)}:${String(second.start.column)} - ${String(second.end.line)}:${String(second.end.column)}]`,
    ]),
    `Found ${String(clones.length)} clones with renamed local bindings.`,
  ].join("\n");
}
