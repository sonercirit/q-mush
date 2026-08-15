export async function runScript(run: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await run();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
