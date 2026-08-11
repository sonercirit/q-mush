import { assertPublicPageUrl } from "../page-fetch-process.ts";
import { fetchRenderedPage } from "../page-fetch.ts";

const [operation, value] = Bun.argv.slice(2);

if ((operation !== "fetch" && operation !== "unsafe") || value === undefined) {
  throw new Error("Expected fetch|unsafe and a page URL");
}

const url = new URL(value);

if (operation === "fetch") {
  // The page-fetch maximum timeout: slow CI Chromium startups and external
  // fetches otherwise exceed the 30-second default and flake the probe.
  const output = await fetchRenderedPage({ timeout: 120, url: url.toString() });
  const result: unknown = JSON.parse(output);
  if (
    typeof result !== "object" ||
    result === null ||
    !("title" in result) ||
    typeof result.title !== "string"
  ) {
    throw new Error("Page fetch returned an invalid title");
  }
  console.log(result.title);
} else {
  try {
    await assertPublicPageUrl(url);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Page URL resolves to an unsafe network destination"
    ) {
      console.log("unsafe");
      process.exit(0);
    }
    throw error;
  }
  throw new Error("Expected an unsafe page URL");
}
