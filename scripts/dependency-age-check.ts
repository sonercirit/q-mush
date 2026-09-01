const MINIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const REGISTRY_ORIGIN = "https://registry.npmjs.org";
const CONCURRENCY = 8;
const RETRIES = 3;

interface RegistryMetadata {
  readonly time?: Readonly<Record<string, string>>;
}

interface ResolvedPackage {
  readonly name: string;
  readonly version: string;
}

const sleep = async (milliseconds: number): Promise<void> => {
  await Bun.sleep(milliseconds);
};

const readResolvedPackages = async (): Promise<readonly ResolvedPackage[]> => {
  const lock = await Bun.file("bun.lock").text();
  const packages = new Map<string, ResolvedPackage>();
  const tuplePattern = /^\s+"(?:[^"\\]|\\.)+": \["((?:[^"\\]|\\.)+)"/gmu;

  for (const match of lock.matchAll(tuplePattern)) {
    const encodedResolution = match[1] ?? "";
    const resolution = encodedResolution.replaceAll(/\\(["\\])/gu, "$1");
    const separator = resolution.lastIndexOf("@");
    if (separator <= 0) continue;
    const name = resolution.slice(0, separator);
    const version = resolution.slice(separator + 1);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) continue;
    packages.set(`${name}@${version}`, { name, version });
  }

  if (packages.size === 0)
    throw new Error("bun.lock contained no npm packages");
  const resolved = [...packages.values()];
  resolved.sort((left, right) => {
    const names = left.name.localeCompare(right.name);
    return names === 0 ? left.version.localeCompare(right.version) : names;
  });
  return resolved;
};

const fetchMetadata = async (name: string): Promise<RegistryMetadata> => {
  const url = `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("time" in body)) {
        throw new Error("response omitted publish times");
      }
      const time = body.time;
      if (typeof time !== "object" || time === null) {
        throw new Error("response had invalid publish times");
      }
      return {
        time: Object.fromEntries(
          Object.entries(time).filter((entry) => typeof entry[1] === "string"),
        ),
      };
    } catch (error) {
      lastError = new Error(`attempt ${String(attempt)}: ${String(error)}`);
      if (attempt < RETRIES) await sleep(250 * 2 ** (attempt - 1));
    }
  }

  throw new Error(`npm registry lookup failed for ${name}`, {
    cause: lastError,
  });
};

const formatAge = (milliseconds: number): string =>
  `${(milliseconds / (24 * 60 * 60 * 1_000)).toFixed(2)} days`;

const main = async (): Promise<void> => {
  const packages = await readResolvedPackages();
  const metadata = new Map<string, RegistryMetadata>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < packages.length) {
      const packageName = packages[cursor]?.name;
      cursor += 1;
      if (packageName === undefined || metadata.has(packageName)) continue;
      metadata.set(packageName, await fetchMetadata(packageName));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, packages.length) }, worker),
  );

  const now = Date.now();
  const offenders: string[] = [];
  for (const dependency of packages) {
    const published = metadata.get(dependency.name)?.time?.[dependency.version];
    if (published === undefined) {
      throw new Error(
        `npm registry has no publish time for ${dependency.name}@${dependency.version}`,
      );
    }
    const age = now - Date.parse(published);
    if (!Number.isFinite(age)) {
      throw new Error(
        `npm registry returned an invalid publish time for ${dependency.name}@${dependency.version}`,
      );
    }
    if (age < MINIMUM_AGE_MS) {
      offenders.push(
        `${dependency.name}@${dependency.version} (${formatAge(age)} old; ${published})`,
      );
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      `Dependencies must be at least 7 days old:\n${offenders.map((value) => `- ${value}`).join("\n")}`,
    );
  }
  console.log(
    `Checked ${String(packages.length)} resolved dependency versions; all are at least 7 days old.`,
  );
};

await main();
