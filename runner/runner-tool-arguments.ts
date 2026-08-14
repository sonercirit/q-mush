import { readBoundedString } from "../shared/validation.ts";

export type ToolArguments = Readonly<Record<string, unknown>>;

export interface IntegerBounds {
  readonly minimum: number;
  readonly maximum: number;
}

export function requiredString(
  arguments_: ToolArguments,
  name: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  const value = readBoundedString(arguments_[name], maximumLength, allowEmpty);

  if (value === undefined) {
    throw new Error(`Tool argument ${name} must be a valid string`);
  }

  return value;
}

function integerBoundsError(name: string, bounds: IntegerBounds): Error {
  return new Error(
    `Tool argument ${name} must be an integer from ${String(bounds.minimum)} to ${String(bounds.maximum)}`,
  );
}

function readOptionalInteger(
  arguments_: ToolArguments,
  name: string,
  bounds: IntegerBounds,
): number | undefined {
  const value = arguments_[name];

  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < bounds.minimum ||
    value > bounds.maximum
  ) {
    throw integerBoundsError(name, bounds);
  }

  return value;
}

export function optionalInteger(
  arguments_: ToolArguments,
  name: string,
  fallback: number,
  bounds: IntegerBounds,
): number {
  return readOptionalInteger(arguments_, name, bounds) ?? fallback;
}

export function requiredInteger(
  arguments_: ToolArguments,
  name: string,
  bounds: IntegerBounds,
): number {
  const value = readOptionalInteger(arguments_, name, bounds);

  if (value === undefined) {
    throw integerBoundsError(name, bounds);
  }

  return value;
}
