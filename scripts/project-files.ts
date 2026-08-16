import { join } from "node:path";

export async function listProjectFiles(
  rootDirectory: string,
): Promise<string[]> {
  const git = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: rootDirectory,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(git.stdout).text(),
    new Response(git.stderr).text(),
    git.exited,
  ]);

  if (exitCode !== 0) {
    const detail = stderr.trim();
    throw new Error(
      detail === ""
        ? "Could not list project files with git."
        : `Could not list project files with git: ${detail}`,
    );
  }

  const paths = stdout
    .split("\0")
    .filter((path) => path !== "")
    .sort((left, right) => left.localeCompare(right));
  const existingPaths: string[] = [];

  for (const path of paths) {
    if (await Bun.file(join(rootDirectory, path)).exists()) {
      existingPaths.push(path);
    }
  }

  return existingPaths;
}
