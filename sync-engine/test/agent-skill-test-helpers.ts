export type BraveSearchExecute = (
  arguments_: Readonly<Record<string, unknown>>,
) => Promise<string>;

export function testBraveSearchSkill(execute: BraveSearchExecute) {
  return {
    execute: (_userId: string, arguments_: Readonly<Record<string, unknown>>) =>
      execute(arguments_),
  };
}
