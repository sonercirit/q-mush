import { For, Show, type JSX } from "solid-js";
import { isRecord } from "../shared/auth-model.ts";

interface SchemaProperty {
  readonly description: string | undefined;
  readonly name: string;
  readonly required: boolean;
  readonly schema: Readonly<Record<string, unknown>>;
}

function schemaRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function schemaProperties(
  schema: Readonly<Record<string, unknown>>,
): readonly SchemaProperty[] {
  const propertiesValue = schema["properties"];
  const properties = isRecord(propertiesValue) ? propertiesValue : {};
  const requiredValue = schema["required"];
  const required = Array.isArray(requiredValue)
    ? requiredValue.filter((name): name is string => typeof name === "string")
    : [];
  return Object.entries(properties).flatMap(
    ([name, value]): readonly SchemaProperty[] => {
      if (!isRecord(value)) {
        return [];
      }
      return [
        {
          description:
            typeof value["description"] === "string"
              ? value["description"]
              : undefined,
          name,
          required: required.includes(name),
          schema: value,
        },
      ];
    },
  );
}

function schemaType(schema: Readonly<Record<string, unknown>>): string {
  const type = schema["type"];
  if (type !== "array") {
    return typeof type === "string" ? type : "value";
  }
  const itemType = schemaRecord(schema["items"])["type"];
  return `Array of ${typeof itemType === "string" ? itemType : "value"}`;
}

function enumValues(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) =>
    typeof item === "string" ? item : JSON.stringify(item),
  );
}

function constraintText(label: string, value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? `${label}: ${String(value)}`
    : undefined;
}

function SchemaConstraints(props: {
  readonly schema: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const constraints = () =>
    [
      constraintText("Minimum", props.schema["minimum"]),
      constraintText("Maximum", props.schema["maximum"]),
      constraintText("Minimum items", props.schema["minItems"]),
      constraintText("Maximum items", props.schema["maxItems"]),
    ].filter((value) => value !== undefined);
  const enumeration = () => enumValues(props.schema["enum"]);
  return (
    <>
      <For each={constraints()}>
        {(constraint) => <span class="block">{constraint}</span>}
      </For>
      <Show when={enumeration().length > 0}>
        <span class="block">Allowed values: {enumeration().join(", ")}</span>
      </Show>
    </>
  );
}

function NestedSchemaProperties(props: {
  readonly depth: number;
  readonly label?: string;
  readonly properties: readonly SchemaProperty[];
}): JSX.Element {
  return (
    <Show when={props.depth < 3 && props.properties.length > 0}>
      <Show when={props.label !== undefined}>
        <p class="mt-2 text-[0.65rem] font-semibold tracking-wide text-slate-500 uppercase">
          {props.label}
        </p>
      </Show>
      <ul class="mt-1 space-y-2 border-l border-white/10 pl-3">
        <For each={props.properties}>
          {(property) => {
            const childDepth = props.depth + 1;
            return (
              <SchemaPropertyDetail depth={childDepth} property={property} />
            );
          }}
        </For>
      </ul>
    </Show>
  );
}

function SchemaPropertyDetail(props: {
  readonly depth?: number;
  readonly property: SchemaProperty;
}): JSX.Element {
  const nestedProperties = () => schemaProperties(props.property.schema);
  const itemSchema = () => schemaRecord(props.property.schema["items"]);
  const nestedItemProperties = () => schemaProperties(itemSchema());
  return (
    <li class="min-w-0">
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <code class="break-all text-xs font-semibold text-cyan-200">
          {props.property.name}
        </code>
        <span class="text-[0.7rem] font-medium tracking-wide text-slate-500 uppercase">
          {schemaType(props.property.schema)}
        </span>
        <Show when={props.property.required}>
          <span class="rounded-full bg-amber-300/10 px-2 py-0.5 text-[0.65rem] font-semibold text-amber-200">
            Required
          </span>
        </Show>
      </div>
      <Show when={props.property.description !== undefined}>
        <p class="mt-1 text-xs leading-5 text-slate-400">
          {props.property.description}
        </p>
      </Show>
      <p class="mt-1 text-[0.7rem] leading-5 text-slate-500">
        <SchemaConstraints schema={props.property.schema} />
      </p>
      <NestedSchemaProperties
        depth={props.depth ?? 0}
        properties={nestedProperties()}
      />
      <NestedSchemaProperties
        depth={props.depth ?? 0}
        label="Item properties"
        properties={nestedItemProperties()}
      />
    </li>
  );
}

export function ToolParameterDetails(props: {
  readonly parameters: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const properties = () => schemaProperties(props.parameters);
  return (
    <Show
      fallback={<p class="text-xs text-slate-500">No parameters.</p>}
      when={properties().length > 0}
    >
      <ul class="space-y-3">
        <For each={properties()}>
          {(property) => <SchemaPropertyDetail property={property} />}
        </For>
      </ul>
    </Show>
  );
}
