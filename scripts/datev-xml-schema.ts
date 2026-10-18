/**
 * Regenerates src/finance/datev-xml-schema.ts from the unpacked DATEV XSD archive.
 * Usage: bun scripts/datev-xml-schema.ts <directory with the unpacked XSD_*.zip>
 * Only reads the four document/ledger schemas; the files are embedded byte-for-byte.
 */
import { join } from "node:path";

const names = ["Document_v060.xsd", "Document_types_v060.xsd", "Belegverwaltung_online_ledger_import_v060.xsd", "Belegverwaltung_online_ledger_types_v060.xsd"];
const directory = process.argv[2];
if (!directory) throw new Error("Usage: bun scripts/datev-xml-schema.ts <xsd directory>");
const schemas: Record<string, string> = {};
for (const name of names) {
  const bytes = await Bun.file(join(directory, name)).bytes();
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (new TextEncoder().encode(text).byteLength !== bytes.byteLength) throw new Error(`${name} does not round-trip as UTF-8.`);
  schemas[name] = text;
}
const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(schemas)).digest("hex");
const source = "// DATEV XML-Schnittstelle online 6.0 XSDs (document and ledger). See datev-xml-schema-NOTICE.md.\n" +
  `export const datevXmlSchemas: Record<string, string> = ${JSON.stringify(schemas)};\n`;
await Bun.write(new URL("../src/finance/datev-xml-schema.ts", import.meta.url).pathname, source);
// Pin this value as datevXmlSchemaSha256 in src/finance/validate.ts.
console.log(hash);
