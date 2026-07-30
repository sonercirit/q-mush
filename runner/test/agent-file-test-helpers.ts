import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function createTestAgentFileWorkspace(
  temporaryDirectory: () => Promise<string>,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await temporaryDirectory();
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeTestAgentFile(root, name, content),
    ),
  );
  return root;
}

export async function writeTestAgentFile(
  root: string,
  path: string,
  content: string,
): Promise<string> {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  return absolutePath;
}
