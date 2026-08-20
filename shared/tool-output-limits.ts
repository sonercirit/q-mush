const TOOL_OUTPUT_NOTICE_PREFIX = "\n\n[Tool output truncated: ";
const TOOL_OUTPUT_NOTICE_SUFFIX =
  " Unicode character limit reached; omitted content is unavailable.]";

export function codePointPrefix(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  let codePoints = 0;
  let end = 0;
  for (const character of value) {
    if (codePoints === maximum) break;
    end += character.length;
    codePoints += 1;
  }
  return value.slice(0, end);
}

export function unicodeCharacterCount(value: string): number {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

export function toolOutputTruncationNotice(maximum: number): string {
  return `${TOOL_OUTPUT_NOTICE_PREFIX}${maximum.toLocaleString("en-US")}${TOOL_OUTPUT_NOTICE_SUFFIX}`;
}

/** The sole final model-facing output bound, measured in Unicode code points. */
function boundToolOutput(
  output: string,
  settings: { readonly outputLimitCharacters: number },
): string {
  const maximum = settings.outputLimitCharacters;
  if (unicodeCharacterCount(output) <= maximum) return output;
  const notice = toolOutputTruncationNotice(maximum);
  const noticeLength = unicodeCharacterCount(notice);
  return `${codePointPrefix(output, maximum - noticeLength)}${notice}`;
}

function limitResultOutput<Result extends { readonly output: string }>(
  result: Result,
  maximum: number,
): Result {
  const output = codePointPrefix(result.output, maximum);
  return output === result.output ? result : { ...result, output };
}

/** Retains one extra code point so the engine can detect runner overflow. */
export function retainToolResultOverflow<
  Result extends { readonly output: string },
>(
  result: Result,
  settings: { readonly outputLimitCharacters: number },
): Result {
  return limitResultOutput(result, settings.outputLimitCharacters + 1);
}

export function boundToolResult<Result extends { readonly output: string }>(
  result: Result,
  settings: { readonly outputLimitCharacters: number },
): Result {
  const bounded = boundToolOutput(result.output, settings);
  return bounded === result.output ? result : { ...result, output: bounded };
}
