import { describe, expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRunnerAgentFile } from "../runner-agent-file.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories("q-mush-agent-file-test-");

describe("runner agent file", () => {
  test("prefers AGENTS.md, falls back to CLAUDE.md, and allows neither", async () => {
    const scenarios = [
      {
        expected: { content: "Agents instructions", name: "AGENTS.md" },
        files: { "AGENTS.md": "Agents instructions" },
      },
      {
        expected: { content: "Claude instructions", name: "CLAUDE.md" },
        files: { "CLAUDE.md": "Claude instructions" },
      },
      {
        expected: { content: "Preferred instructions", name: "AGENTS.md" },
        files: {
          "AGENTS.md": "Preferred instructions",
          "CLAUDE.md": "Ignored instructions",
        },
      },
      { expected: null, files: {} },
    ] as const;

    for (const scenario of scenarios) {
      const root = await temporaryDirectory();

      await Promise.all(
        Object.entries(scenario.files).map(([name, content]) =>
          writeFile(join(root, name), content),
        ),
      );

      expect(await loadRunnerAgentFile(root)).toEqual(scenario.expected);
    }
  });

  test("confines agent files to the workspace", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const outsideFile = join(outside, "instructions.md");
    await writeFile(outsideFile, "Outside instructions");
    await symlink(outsideFile, join(root, "AGENTS.md"));

    expect(loadRunnerAgentFile(root)).rejects.toThrow(
      "outside the session workspace",
    );
  });

  test("loads agent files without a size limit", async () => {
    const root = await temporaryDirectory();
    const content = "x".repeat(65 * 1_024);
    await writeFile(join(root, "AGENTS.md"), content);

    expect(await loadRunnerAgentFile(root)).toEqual({
      content,
      name: "AGENTS.md",
    });
  });
});
