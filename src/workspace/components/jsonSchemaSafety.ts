import type { JSONSchema } from "./componentTypes";

export type UnsafeJsonSchemaKeyword = Readonly<{
  keyword:
    | "pattern"
    | "patternProperties"
    | "$ref"
    | "$dynamicRef"
    | "$recursiveRef"
    | "$defs"
    | "definitions"
    | "$anchor"
    | "$dynamicAnchor"
    | "allOf"
    | "anyOf"
    | "oneOf"
    | "not"
    | "if"
    | "then"
    | "else"
    | "dependencies"
    | "dependentSchemas"
    | "uniqueItems"
    | "enum"
    | "required"
    | "schemaNodeLimit";
  path: string;
}>;

export const MAX_UNTRUSTED_JSON_SCHEMA_BYTES = 65_536;
export const MAX_UNTRUSTED_JSON_SCHEMA_NODES = 256;
export const MAX_UNTRUSTED_JSON_SCHEMA_ENUM_VALUES = 256;
export const MAX_UNTRUSTED_JSON_SCHEMA_REQUIRED_KEYS = 256;

const SCHEMA_MAP_KEYWORDS = [
  "properties",
] as const;

const SINGLE_SCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "items",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

const SCHEMA_ARRAY_KEYWORDS = ["prefixItems"] as const;

const FORBIDDEN_REFERENCE_KEYWORDS = [
  "$ref", "$dynamicRef", "$recursiveRef", "$defs", "definitions", "$anchor", "$dynamicAnchor",
] as const;

const FORBIDDEN_COMPOSITION_KEYWORDS = [
  "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependencies", "dependentSchemas",
] as const;

/**
 * Declarative schemas run synchronously in the browser and loopback gateway.
 * ECMAScript regular expressions can exhibit catastrophic backtracking, so
 * untrusted recipe/resource schemas use a deliberately regex-free profile.
 * References and branching composition are also forbidden: otherwise a local
 * ref or compact combinator graph can multiply validation work exponentially.
 * The remaining profile has explicit node/list limits and forbids quadratic
 * deep-equality checks through uniqueItems.
 * Built-in manifests are trusted code and do not pass through this boundary.
 */
export function findUnsafeJsonSchemaKeyword(schema: JSONSchema): UnsafeJsonSchemaKeyword | null {
  const visited = new Set<object>();
  let nodeCount = 0;
  const inspect = (candidate: unknown, path: string): UnsafeJsonSchemaKeyword | null => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    if (visited.has(candidate)) return null;
    visited.add(candidate);
    nodeCount += 1;
    if (nodeCount > MAX_UNTRUSTED_JSON_SCHEMA_NODES) {
      return { keyword: "schemaNodeLimit", path };
    }
    const record = candidate as Record<string, unknown>;
    if (Object.hasOwn(record, "pattern")) return { keyword: "pattern", path: `${path}.pattern` };
    if (Object.hasOwn(record, "patternProperties")) {
      return { keyword: "patternProperties", path: `${path}.patternProperties` };
    }
    for (const keyword of FORBIDDEN_REFERENCE_KEYWORDS) {
      if (Object.hasOwn(record, keyword)) return { keyword, path: `${path}.${keyword}` };
    }
    for (const keyword of FORBIDDEN_COMPOSITION_KEYWORDS) {
      if (Object.hasOwn(record, keyword)) return { keyword, path: `${path}.${keyword}` };
    }
    if (record.uniqueItems === true) return { keyword: "uniqueItems", path: `${path}.uniqueItems` };
    if (Array.isArray(record.enum) && record.enum.length > MAX_UNTRUSTED_JSON_SCHEMA_ENUM_VALUES) {
      return { keyword: "enum", path: `${path}.enum` };
    }
    if (Array.isArray(record.required) && record.required.length > MAX_UNTRUSTED_JSON_SCHEMA_REQUIRED_KEYS) {
      return { keyword: "required", path: `${path}.required` };
    }

    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const map = record[keyword];
      if (!map || typeof map !== "object" || Array.isArray(map)) continue;
      for (const [name, child] of Object.entries(map)) {
        const found = inspect(child, `${path}.${keyword}.${name}`);
        if (found) return found;
      }
    }
    for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
      const child = record[keyword];
      if (Array.isArray(child)) {
        for (const [index, item] of child.entries()) {
          const found = inspect(item, `${path}.${keyword}[${index}]`);
          if (found) return found;
        }
      } else {
        const found = inspect(child, `${path}.${keyword}`);
        if (found) return found;
      }
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      const items = record[keyword];
      if (!Array.isArray(items)) continue;
      for (const [index, child] of items.entries()) {
        const found = inspect(child, `${path}.${keyword}[${index}]`);
        if (found) return found;
      }
    }
    return null;
  };
  return inspect(schema, "$schema");
}
