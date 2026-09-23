import { invalid, type FinanceResult } from "./common";

export const sepaSchemaSha256 = "35cfe972a636392704fd930c3e0496fc05b95ff891deb635b168dcdabf3c08a3";

/** Check XML against the pinned DK XSD; does not check business rules or totals. */
export async function validateSepaXml(xml: string): Promise<FinanceResult<void>> {
  if (typeof xml !== "string" || xml.includes("<!")) {
    return invalid([{ code: "invalid_xml", path: ["xml"], message: "Expected XML without DTD, comments or CDATA." }]);
  }
  // XSD and WASM are not loaded by DATEV, input validation or normal stdlib imports.
  try {
    const { validatePinnedXml } = await import("./sepa-validator");
    return await validatePinnedXml(xml, sepaSchemaSha256);
  } catch {
    return invalid([{ code: "validator_unavailable", path: [], message: "SEPA validation requires libxml2-wasm@0.6.0 and Web Crypto." }], true);
  }
}

export const camtSchemaSha256 = "589b55980dd6e553de78ba036eb733308da201bda4c3158e10b22cb003911e8f";

/** Validate ISO camt.052.001.08, not a bank-specific usage profile or accounting semantics. */
export async function validateCamtXml(xml: string, options?: import("./camt-types").CamtParseOptions): Promise<FinanceResult<void>> {
  // The JS reader enforces namespace, DTD and resource boundaries before invoking WASM.
  try {
    const { readCamtXml, CamtReadError } = await import("./camt-xml");
    try { readCamtXml(xml, options); }
    catch (error) {
      if (error instanceof CamtReadError) return invalid([error.issue]);
      throw error;
    }
    const [{ validateSchemaXml }, { camtSchema }] = await Promise.all([
      import("./xml-schema-validator"), import("./camt-schema"),
    ]);
    return await validateSchemaXml(xml, camtSchema, camtSchemaSha256);
  } catch {
    return invalid([{ code: "validator_unavailable", path: [], message: "CAMT validation requires saxes@6, libxml2-wasm@0.6.0 and Web Crypto." }], true);
  }
}

/** Check the pinned CII EN16931 profile XSD only. Does not execute Schematron or recalculate amounts. */
export async function validateInvoiceXml(xml: string, options: { format: import("./einvoice-contracts").InvoiceFormat; mode?: "incoming" } & import("./einvoice-contracts").InvoiceParseOptions): Promise<FinanceResult<void>> {
  if (options?.format !== "zugferd-2.5-en16931") return invalid([{ code: "unsupported_format", path: ["format"], message: "Expected zugferd-2.5-en16931." }]);
  const { format: _, mode, ...limits } = options;
  if (mode !== undefined && mode !== "incoming") return invalid([{ code: "invalid_input", path: ["options", "mode"], message: "Unknown invoice validation mode." }]);
  const { readInvoiceTree, InvoiceReadError } = await import("./einvoice-read");
  try { readInvoiceTree(xml, limits, mode === "incoming"); }
  catch (error) { if (error instanceof InvoiceReadError) return invalid([error.issue]); throw error; }
  try {
    const { validateInvoiceSchema } = await import("./einvoice-validator");
    return await validateInvoiceSchema(xml);
  } catch {
    return invalid([{ code: "validator_unavailable", path: [], message: "Invoice XSD validation requires libxml2-wasm@0.6.0 and Web Crypto." }], true);
  }
}
