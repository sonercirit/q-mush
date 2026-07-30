import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadRunnerAgentFile } from "../../runner/runner-agent-file.ts";
import {
  createTestAgentFileWorkspace,
  writeTestAgentFile,
} from "./agent-file-test-helpers.ts";
import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories("q-mush-agent-file-test-");

interface AgentFileScenario {
  readonly customPath?: string;
  readonly expectedContent: string | null;
  readonly expectedName?: string;
}

async function expectAgentFileScenario(
  root: string,
  scenario: AgentFileScenario,
): Promise<void> {
  const result = await loadRunnerAgentFile(root, scenario.customPath);
  if (scenario.expectedContent === null) {
    expect(result).toBeNull();
  } else {
    expect(result).toEqual({
      content: scenario.expectedContent,
      name: scenario.expectedName ?? scenario.customPath ?? "AGENTS.md",
    });
  }
}

async function symlinkOutsideAgentFile(
  linkName: string,
): Promise<{ readonly root: string }> {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const outsideFile = await writeTestAgentFile(
    outside,
    "instructions.md",
    "Outside instructions",
  );
  await symlink(outsideFile, join(root, linkName));
  return { root };
}

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
      const root = await createTestAgentFileWorkspace(
        temporaryDirectory,
        scenario.files,
      );

      expect(await loadRunnerAgentFile(root)).toEqual(scenario.expected);
    }
  });

  test("resolves a custom relative path from the workspace", async () => {
    const root = await temporaryDirectory();
    await writeTestAgentFile(root, "config/instructions.md", "Custom rules");

    await expectAgentFileScenario(root, {
      customPath: "config/instructions.md",
      expectedContent: "Custom rules",
    });
  });

  test("does not fall back when a custom path is missing", async () => {
    const root = await temporaryDirectory();
    await writeTestAgentFile(root, "AGENTS.md", "Default instructions");

    await expectAgentFileScenario(root, {
      customPath: "missing.md",
      expectedContent: null,
    });
  });

  test("allows an explicit absolute path outside the workspace", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const path = join(outside, "instructions.md");
    await writeTestAgentFile(
      outside,
      "instructions.md",
      "Outside instructions",
    );

    await expectAgentFileScenario(root, {
      customPath: path,
      expectedContent: "Outside instructions",
    });
  });

  test("confines relative custom agent files to the workspace", async () => {
    const { root } = await symlinkOutsideAgentFile("custom.md");

    await expect(loadRunnerAgentFile(root, "custom.md")).rejects.toThrow(
      "outside the session workspace",
    );
  });

  test("confines default agent files to the workspace", async () => {
    const { root } = await symlinkOutsideAgentFile("AGENTS.md");

    await expect(loadRunnerAgentFile(root)).rejects.toThrow(
      "outside the session workspace",
    );
  });

  test("fails closed for a custom non-regular path", async () => {
    const root = await temporaryDirectory();
    await writeTestAgentFile(root, "instructions/.keep", "");

    await expect(loadRunnerAgentFile(root, "instructions")).rejects.toThrow(
      "not a regular file",
    );
  });

  test("fails closed for a default non-regular path", async () => {
    const root = await temporaryDirectory();
    await writeTestAgentFile(root, "AGENTS.md/.keep", "");
    await writeTestAgentFile(root, "CLAUDE.md", "Ignored instructions");

    await expect(loadRunnerAgentFile(root)).rejects.toThrow(
      "not a regular file",
    );
  });

  test("loads agent files without a size limit", async () => {
    const root = await temporaryDirectory();
    const content = "x".repeat(65 * 1_024);
    await writeTestAgentFile(root, "AGENTS.md", content);

    await expectAgentFileScenario(root, { expectedContent: content });
  });
});
