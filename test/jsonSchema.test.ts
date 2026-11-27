import { describe, expect, it } from 'vitest';
import { validateAgainstSchema, type JsonSchema } from '../src/jsonSchema.js';

describe('validateAgainstSchema', () => {
  it('accepts a value matching a primitive type and rejects a mismatch', () => {
    expect(validateAgainstSchema({ type: 'string' }, 'ok')).toEqual([]);
    expect(validateAgainstSchema({ type: 'string' }, 5)).toEqual(['$: expected a string, got number']);
    expect(validateAgainstSchema({ type: 'boolean' }, true)).toEqual([]);
    expect(validateAgainstSchema({ type: 'boolean' }, 'true')).toEqual(['$: expected a boolean, got string']);
  });

  it('requires a number to be finite and checks minimum', () => {
    expect(validateAgainstSchema({ type: 'number', minimum: 0 }, 5)).toEqual([]);
    expect(validateAgainstSchema({ type: 'number', minimum: 0 }, -1)).toEqual(['$: must be >= 0, got -1']);
    expect(validateAgainstSchema({ type: 'number' }, Number.NaN)).toEqual(['$: expected a number, got number']);
    expect(validateAgainstSchema({ type: 'integer' }, 1.5)).toEqual(['$: expected an integer, got 1.5']);
  });

  it('validates date-time strings', () => {
    expect(validateAgainstSchema({ type: 'string', format: 'date-time' }, '2026-01-01T00:00:00.000Z')).toEqual([]);
    expect(validateAgainstSchema({ type: 'string', format: 'date-time' }, 'yesterday')).toEqual([
      '$: not a valid date-time: "yesterday"',
    ]);
  });

  it('checks enum membership', () => {
    const schema: JsonSchema = { enum: ['a', 'b'] };
    expect(validateAgainstSchema(schema, 'a')).toEqual([]);
    expect(validateAgainstSchema(schema, 'c')).toEqual(['$: expected one of ["a","b"], got "c"']);
  });

  it('checks required object properties, reports every property, and never throws on null/array in place of an object', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    };
    expect(validateAgainstSchema(schema, { a: 'x', b: 1 })).toEqual([]);
    expect(validateAgainstSchema(schema, { a: 'x' })).toEqual(['$.b: required property is missing']);
    expect(validateAgainstSchema(schema, {})).toEqual([
      '$.a: required property is missing',
      '$.b: required property is missing',
    ]);
    expect(validateAgainstSchema(schema, null)).toEqual(['$: expected an object, got null']);
    expect(validateAgainstSchema(schema, [])).toEqual(['$: expected an object, got an array']);
  });

  it('treats a present-but-wrong-type property as its own error, independent of required', () => {
    const schema: JsonSchema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(validateAgainstSchema(schema, { a: 5 })).toEqual(['$.a: expected a string, got number']);
  });

  it('does not require a property that is simply absent, matching JSON.stringify dropping undefined', () => {
    const schema: JsonSchema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(validateAgainstSchema(schema, {})).toEqual([]);
  });

  it('flags a property not declared in the schema when additionalProperties is false', () => {
    const schema: JsonSchema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    expect(validateAgainstSchema(schema, { a: 'x', extra: 1 })).toEqual(['$.extra: property is not in the schema']);
    expect(validateAgainstSchema({ ...schema, additionalProperties: undefined }, { a: 'x', extra: 1 })).toEqual([]);
  });

  it('validates every array item and reports the offending index', () => {
    const schema: JsonSchema = { type: 'array', items: { type: 'number' } };
    expect(validateAgainstSchema(schema, [1, 2, 3])).toEqual([]);
    expect(validateAgainstSchema(schema, [1, 'two', 3])).toEqual(['$[1]: expected a number, got string']);
    expect(validateAgainstSchema(schema, 'not an array')).toEqual(['$: expected an array, got string']);
  });

  it('resolves $ref against the root schema\'s definitions, including nested refs', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['tier'],
      properties: { tier: { $ref: '#/definitions/tier' } },
      definitions: { tier: { enum: ['low', 'high'] } },
    };
    expect(validateAgainstSchema(schema, { tier: 'high' })).toEqual([]);
    expect(validateAgainstSchema(schema, { tier: 'medium' })).toEqual([
      '$.tier: expected one of ["low","high"], got "medium"',
    ]);
  });

  it('throws a clear error for an unresolvable $ref, rather than silently accepting anything', () => {
    const schema: JsonSchema = { $ref: '#/definitions/missing' };
    expect(() => validateAgainstSchema(schema, 'anything')).toThrow(/unsupported or unresolved \$ref/);
  });
});
