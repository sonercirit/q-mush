export function readBuildArtifact(
  label: string,
  result: Bun.BuildOutput,
): Bun.BuildArtifact {
  if (!result.success) {
    const details = result.logs.map(({ message }) => message).join("\n");
    throw new Error(
      details.length === 0
        ? `Could not build the ${label}`
        : `Could not build the ${label}:\n${details}`,
    );
  }

  const output = result.outputs[0];

  if (output === undefined) {
    throw new Error(`The ${label} build did not produce an output`);
  }

  return output;
}
