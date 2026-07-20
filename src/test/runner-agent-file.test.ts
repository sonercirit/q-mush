import { describe, expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAXIMUM_AGENT_FILE_BYTES } from "../agent-file.ts";
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

  test("confines bounded agent files to the workspace", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const outsideFile = join(outside, "instructions.md");
    await writeFile(outsideFile, "Outside instructions");
    await symlink(outsideFile, join(root, "AGENTS.md"));

    expect(loadRunnerAgentFile(root)).rejects.toThrow(
      "outside the session workspace",
    );

    const largeRoot = await temporaryDirectory();
    await writeFile(
      join(largeRoot, "AGENTS.md"),
      "x".repeat(MAXIMUM_AGENT_FILE_BYTES + 1),
    );
    expect(loadRunnerAgentFile(largeRoot)).rejects.toThrow("exceeds");
  });
});
