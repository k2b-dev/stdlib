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

