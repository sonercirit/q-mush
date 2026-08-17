const reportPath = process.argv[2];
if (reportPath === undefined) {
  throw new Error("Browser lifecycle probe requires a report path");
}

const descendant = Bun.spawn(
  [process.execPath, "-e", "await new Promise(() => {})"],
  { stderr: "ignore", stdin: "ignore", stdout: "ignore" },
);
await Bun.write(
  reportPath,
  JSON.stringify({
    descendantPid: descendant.pid,
    vitestPid: process.pid,
  }),
);
await new Promise(() => {
  // The test kills this browser stand-in.
});
