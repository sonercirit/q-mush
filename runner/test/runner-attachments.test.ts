import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  ATTACHMENT_READ_COMMAND,
  ATTACHMENT_WRITE_COMMAND,
} from "../../shared/attachment-reference.ts";
import { executeAttachmentCommand } from "../runner-attachments.ts";
import { executeRunnerTool } from "../runner-tools.ts";

import { useTemporaryDirectories } from "./temporary-directories.ts";

const temporaryDirectory = useTemporaryDirectories("q-mush-attachment-test-");
const CONTAINMENT_ERROR = "The requested path is outside the session workspace";

async function createEscapePaths(outsideName: string): Promise<{
  readonly attachmentDirectory: string;
  readonly outsideDirectory: string;
  readonly outsideFile: string;
  readonly root: string;
}> {
  const [root, outside] = [
    await temporaryDirectory(),
    await temporaryDirectory(),
  ];
  return {
    attachmentDirectory: join(root, ".q-mush", "attachments"),
    outsideDirectory: outside,
    outsideFile: join(outside, outsideName),
    root,
  };
}

describe("runner attachments", () => {
  test("transcodes an attachment into a read-tool reference", async () => {
    const root = await temporaryDirectory();
    expect(
      await executeAttachmentCommand(root, ATTACHMENT_WRITE_COMMAND, {
        description: "hello",
        id: "attachment-1",
        mediaType: "text/plain",
        name: "notes.txt",
      }),
    ).toBe('{"id":"attachment-1","name":"notes.txt"}');
    const reference = "q-mush-attachment://file/attachment-1/notes.txt";
    const containedReference =
      "q-mush-attachment://file/attachment-2/notes.txt";
    await symlink(
      "attachment-1",
      join(root, ".q-mush", "attachments", "attachment-2"),
    );

    expect(
      await executeAttachmentCommand(root, ATTACHMENT_READ_COMMAND, {
        reference,
      }),
    ).toContain("attachment-1");
    expect(
      await executeRunnerTool(root, "read", { path: reference }),
    ).toContain('"description":"hello"');
    expect(
      await executeRunnerTool(root, "read", { path: containedReference }),
    ).toContain('"description":"hello"');
  });

  test("writes through a contained attachment-directory symlink", async () => {
    const root = await temporaryDirectory();
    const attachmentDirectory = join(root, ".q-mush", "attachments");
    const containedDirectory = join(root, "contained-attachments");
    await mkdir(join(attachmentDirectory, ".."), { recursive: true });
    await mkdir(containedDirectory);
    await symlink(containedDirectory, attachmentDirectory);

    await executeAttachmentCommand(root, ATTACHMENT_WRITE_COMMAND, {
      description: "contained metadata",
      id: "contained-id",
      mediaType: "text/plain",
      name: "notes.txt",
    });

    expect(
      await Bun.file(join(containedDirectory, "contained-id")).json(),
    ).toEqual({
      description: "contained metadata",
      mediaType: "text/plain",
      name: "notes.txt",
    });
  });

  test("rejects an attachment directory symlink that escapes on write", async () => {
    const { attachmentDirectory, outsideDirectory, outsideFile, root } =
      await createEscapePaths("forged-id");
    await mkdir(join(root, ".q-mush"), { recursive: true });
    await symlink(outsideDirectory, attachmentDirectory);

    await expect(
      executeAttachmentCommand(root, ATTACHMENT_WRITE_COMMAND, {
        description: "should remain contained",
        id: "forged-id",
        mediaType: "text/plain",
        name: "notes.txt",
      }),
    ).rejects.toThrow(CONTAINMENT_ERROR);
    expect(await Bun.file(outsideFile).exists()).toBe(false);
  });

  test("rejects attachment symlinks that escape the workspace", async () => {
    const { attachmentDirectory, outsideFile, root } =
      await createEscapePaths("secret.txt");
    await mkdir(attachmentDirectory, { recursive: true });
    await writeFile(outsideFile, "outside-secret");
    await symlink(outsideFile, join(attachmentDirectory, "forged-id"));

    await expect(
      executeRunnerTool(root, "read", {
        path: "q-mush-attachment://file/forged-id/secret.txt",
      }),
    ).rejects.toThrow(CONTAINMENT_ERROR);
  });
});
