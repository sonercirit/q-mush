import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  ATTACHMENT_READ_COMMAND,
  ATTACHMENT_WRITE_COMMAND,
} from "../shared/attachment-reference.ts";
import { readBoundedString } from "../shared/validation.ts";
import {
  containedRunnerPath,
  resolveRunnerWorkspace,
} from "./runner-workspace.ts";

const DIRECTORY = ".q-mush/attachments";
const MAXIMUM_ATTACHMENT_ARGUMENT_LENGTH = 4_096;
const MAXIMUM_REFERENCE_LENGTH = 8_192;

function requiredString(
  arguments_: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = readBoundedString(arguments_[key], {
    maximumLength: MAXIMUM_ATTACHMENT_ARGUMENT_LENGTH,
  });
  if (value === undefined) {
    throw new Error(`Attachment argument ${key} is invalid`);
  }
  return value;
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z\d-]{1,200}$/u.test(value)) {
    throw new Error("The attachment identifier is invalid");
  }
  return value;
}

function displayName(value: string): string {
  const name = Array.from(basename(value), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? "_" : character;
  }).join("");
  return name.length === 0 ? "attachment" : name.slice(0, 255);
}

async function secureAttachmentDirectory(
  root: string,
  mayNotExist = false,
): Promise<string> {
  const workspace = await resolveRunnerWorkspace(root);
  return containedRunnerPath(workspace, DIRECTORY, mayNotExist);
}

export async function attachmentPathFromReference(
  root: string,
  reference: string,
): Promise<string | undefined> {
  if (!reference.startsWith("q-mush-attachment://")) return undefined;
  if (reference.length > MAXIMUM_REFERENCE_LENGTH) {
    throw new Error("The attachment reference is too long");
  }
  const parsed = new URL(reference);
  if (parsed.protocol !== "q-mush-attachment:") {
    throw new Error("The attachment reference is invalid");
  }
  const [id] = parsed.pathname.slice(1).split("/");
  if (id === undefined) throw new Error("The attachment reference is invalid");
  const directory = await secureAttachmentDirectory(root);
  return containedRunnerPath(directory, safeIdentifier(id));
}

export async function executeAttachmentCommand(
  root: string,
  tool: string,
  arguments_: Readonly<Record<string, unknown>>,
): Promise<string | undefined> {
  if (tool === ATTACHMENT_WRITE_COMMAND) {
    const description = requiredString(arguments_, "description");
    const mediaType = requiredString(arguments_, "mediaType");
    const suppliedName = requiredString(arguments_, "name");
    const id = requiredString(arguments_, "id");
    const name = displayName(suppliedName);
    const directory = await secureAttachmentDirectory(root, true);
    const attachmentId = safeIdentifier(id);
    await mkdir(directory, { recursive: true });
    // Resolve after creation so a later swap of the lexical attachment symlink
    // cannot redirect the write away from this validated canonical directory.
    const canonicalDirectory = await secureAttachmentDirectory(root);
    const path = await containedRunnerPath(
      canonicalDirectory,
      attachmentId,
      true,
    );
    await writeFile(
      path,
      JSON.stringify({
        description,
        mediaType,
        name,
      }),
      { flag: "wx", mode: 0o600 },
    );
    return JSON.stringify({ id, name });
  }
  if (tool !== ATTACHMENT_READ_COMMAND) return undefined;
  const reference = requiredString(arguments_, "reference");
  const path = await attachmentPathFromReference(root, reference);
  if (path === undefined)
    throw new Error("The attachment reference is invalid");
  const details = await stat(path);
  if (!details.isFile()) throw new Error("The attachment is unavailable");
  return path;
}
