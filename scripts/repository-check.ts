import { join } from "node:path";
import {
  findFileLengthViolations,
  formatFileLengthViolations,
} from "./check-file-length.ts";
import {
  findJscpdIgnoreMarkers,
  formatJscpdIgnoreMarkers,
} from "./jscpd-ignore-markers.ts";
import { listProjectFiles } from "./project-files.ts";
import {
  findRawHtmlFileViolations,
  formatRawHtmlFileViolations,
} from "./raw-html-files.ts";
import { runScript } from "./script-entry.ts";
import {
  findTestLocationViolations,
  formatTestLocationViolations,
} from "./test-location.ts";

async function run(): Promise<number> {
  const rootDirectory = join(import.meta.dir, "..");
  const paths = await listProjectFiles(rootDirectory);
  const fileLengthViolations = await findFileLengthViolations(
    rootDirectory,
    paths,
  );
  const jscpdIgnoreMarkers = await findJscpdIgnoreMarkers(rootDirectory, paths);
  const rawHtmlFileViolations = findRawHtmlFileViolations(paths);
  const testLocationViolations = findTestLocationViolations(paths);
  const messages: string[] = [];

  if (fileLengthViolations.length > 0) {
    messages.push(formatFileLengthViolations(fileLengthViolations));
  }

  if (jscpdIgnoreMarkers.length > 0) {
    messages.push(formatJscpdIgnoreMarkers(jscpdIgnoreMarkers));
  }

  if (rawHtmlFileViolations.length > 0) {
    messages.push(formatRawHtmlFileViolations(rawHtmlFileViolations));
  }

  if (testLocationViolations.length > 0) {
    messages.push(formatTestLocationViolations(testLocationViolations));
  }

  if (messages.length === 0) {
    return 0;
  }

  console.error(messages.join("\n\n"));
  return 1;
}

await runScript(run);
