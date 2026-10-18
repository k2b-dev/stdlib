import { ParseOption, XmlBufferInputProvider, XmlDocument, XmlLibError, XmlParseError, XsdValidator, xmlRegisterInputProvider } from "libxml2-wasm";
import { ok } from "../result";
import { invalid, type FinanceIssue, type FinanceResult } from "./common";
import { datevXmlSchemas } from "./datev-xml-schema";

export type DatevXmlSchemaKind = "document" | "ledger";

const prefix = "stdlib-datev-xml-6.0:/";
const entry: Record<DatevXmlSchemaKind, string> = {
  document: "Document_v060.xsd",
  ledger: "Belegverwaltung_online_ledger_import_v060.xsd",
};
let verified: string | undefined;
// Both schemas are compiled together, right after registering the provider and without
// an await in between. Compiled schemas own their resolved imports and stay usable if
// another libxml2 consumer later clears the global input providers.
let compiled: Record<DatevXmlSchemaKind, XsdValidator> | undefined;

function compileSchemas(options: { option: ParseOption }): Record<DatevXmlSchemaKind, XsdValidator> {
  const buffers = Object.fromEntries(Object.entries(datevXmlSchemas).map(([name, schema]) => [prefix + name, new TextEncoder().encode(schema)]));
  // This provider only serves this package's fixed schema URLs. Never clear another caller's
  // providers. Registering again after a failed compilation is harmless.
  if (!xmlRegisterInputProvider(new XmlBufferInputProvider(buffers))) throw new Error("Cannot register DATEV schema provider.");
  const result: Partial<Record<DatevXmlSchemaKind, XsdValidator>> = {};
  try {
    for (const kind of ["document", "ledger"] as const) {
      const schema = XmlDocument.fromString(datevXmlSchemas[entry[kind]]!, { ...options, url: prefix + entry[kind] });
      try { result[kind] = XsdValidator.fromDoc(schema); }
      finally { schema.dispose(); }
    }
  } catch (error) {
    result.document?.dispose();
    result.ledger?.dispose();
    throw error;
  }
  return result as Record<DatevXmlSchemaKind, XsdValidator>;
}

/** Synchronous schema work after integrity verification; no await while WASM documents are open. */
export async function validateDatevSchema(xml: string, kind: DatevXmlSchemaKind, expectedHash: string, path: (string | number)[] = ["xml"]): Promise<FinanceResult<void>> {
  if (verified !== expectedHash) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(datevXmlSchemas)));
    if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") !== expectedHash)
      return invalid([{ code: "schema_integrity", path: [], message: "The pinned DATEV XML schemas have changed." }], true);
    verified = expectedHash;
  }
  const options = { option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NO_SYS_CATALOG };
  let document: XmlDocument | undefined;
  try {
    compiled ??= compileSchemas(options);
    document = XmlDocument.fromString(xml, options);
    compiled[kind].validate(document);
    return ok();
  } catch (error) {
    if (!(error instanceof XmlLibError)) throw error;
    return invalid(error.details.map((detail): FinanceIssue => ({
      code: error instanceof XmlParseError ? "invalid_xml" : "schema_mismatch",
      path, message: detail.message,
      ...(detail.line > 0 ? { line: detail.line } : {}),
      ...(detail.col > 0 ? { column: detail.col } : {}),
    })));
  } finally {
    document?.dispose();
  }
}
