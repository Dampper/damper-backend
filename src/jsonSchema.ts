/**
 * A small, dependency-free validator for the subset of JSON Schema (draft-07) actually used
 * by `schemas/latest.schema.json` and `schemas/oracle-status.schema.json` (#15): object
 * `properties`/`required`/`additionalProperties`, array `items`, `enum`, the primitive
 * types, `minimum`, `format: "date-time"`, and `$ref` to a sibling under the schema's own
 * `definitions`. Not a general JSON Schema implementation — it exists to keep the two
 * generated reports from silently drifting away from the shape damper-frontend expects,
 * without adding a dependency for it.
 */
export interface JsonSchema {
  $ref?: string;
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  format?: string;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minimum?: number;
  definitions?: Record<string, JsonSchema>;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema {
  const m = /^#\/definitions\/([^/]+)$/.exec(ref);
  const resolved = m ? root.definitions?.[m[1]!] : undefined;
  if (!resolved) throw new Error(`unsupported or unresolved $ref: ${ref}`);
  return resolved;
}

/** Every mismatch between `data` and `schema`, as `path: message` strings; empty when valid. */
export function validateAgainstSchema(schema: JsonSchema, data: unknown): string[] {
  const errors: string[] = [];

  function check(node: JsonSchema, value: unknown, path: string): void {
    if (node.$ref) {
      check(resolveRef(schema, node.$ref), value, path);
      return;
    }
    if (node.enum) {
      if (!node.enum.includes(value)) errors.push(`${path}: expected one of ${JSON.stringify(node.enum)}, got ${JSON.stringify(value)}`);
      return;
    }
    switch (node.type) {
      case 'object': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`${path}: expected an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`);
          return;
        }
        const obj = value as Record<string, unknown>;
        for (const key of node.required ?? []) {
          if (!(key in obj)) errors.push(`${path}.${key}: required property is missing`);
        }
        if (node.additionalProperties === false && node.properties) {
          for (const key of Object.keys(obj)) {
            if (!(key in node.properties)) errors.push(`${path}.${key}: property is not in the schema`);
          }
        }
        if (node.properties) {
          for (const [key, sub] of Object.entries(node.properties)) {
            if (key in obj) check(sub, obj[key], `${path}.${key}`);
          }
        }
        return;
      }
      case 'array': {
        if (!Array.isArray(value)) {
          errors.push(`${path}: expected an array, got ${typeof value}`);
          return;
        }
        if (node.items) value.forEach((v, i) => check(node.items!, v, `${path}[${i}]`));
        return;
      }
      case 'string':
        if (typeof value !== 'string') {
          errors.push(`${path}: expected a string, got ${typeof value}`);
        } else if (node.format === 'date-time' && Number.isNaN(Date.parse(value))) {
          errors.push(`${path}: not a valid date-time: ${JSON.stringify(value)}`);
        }
        return;
      case 'number':
      case 'integer':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          errors.push(`${path}: expected a number, got ${typeof value}`);
          return;
        }
        if (node.type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: expected an integer, got ${value}`);
        if (node.minimum !== undefined && value < node.minimum) errors.push(`${path}: must be >= ${node.minimum}, got ${value}`);
        return;
      case 'boolean':
        if (typeof value !== 'boolean') errors.push(`${path}: expected a boolean, got ${typeof value}`);
        return;
      default:
        return; // no type constraint on this node (nothing further to check)
    }
  }

  check(schema, data, '$');
  return errors;
}
