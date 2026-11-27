/**
 * Validates a generated report against its committed JSON Schema (#15), so a drift between
 * `ScanReport`/`StatusReport` and the schema damper-frontend is meant to read fails the
 * workflow that generated the report instead of surfacing only at runtime in the frontend.
 *
 * Usage: tsx src/cli/validateReport.ts <schema.json> <report.json>
 */
import { readFile } from 'node:fs/promises';
import { validateAgainstSchema, type JsonSchema } from '../jsonSchema.js';

async function main(): Promise<void> {
  const [schemaPath, reportPath] = process.argv.slice(2);
  if (!schemaPath || !reportPath) {
    throw new Error('usage: validateReport <schema.json> <report.json>');
  }
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as JsonSchema;
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as unknown;
  const errors = validateAgainstSchema(schema, report);
  if (errors.length > 0) {
    console.error(`${reportPath} does not match ${schemaPath}:`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`${reportPath} matches ${schemaPath}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
