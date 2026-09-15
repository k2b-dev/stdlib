import { ok } from "../result";
import { invalid, validate, type FinanceResult } from "./common";
import { calculateInvoice, checkInvoiceTotals, invoiceFormat, invoiceSchema, type Invoice, type InvoiceFormat, type InvoicePdfOptions, type InvoiceXmlFile, type ParsedInvoice } from "./einvoice-contracts";
import { parseInvoiceXml } from "./einvoice-read";
import { writeInvoiceXml } from "./einvoice-write";

function serialize(invoice: Invoice, options: { format: InvoiceFormat }): FinanceResult<InvoiceXmlFile> {
  if (options?.format !== invoiceFormat) return invalid([{ code: "unsupported_format", path: ["format"], message: `Expected ${invoiceFormat}.` }]);
  const checked = validate(invoiceSchema, invoice);
  if (!checked.ok) return checked;
  const calculated = calculateInvoice(checked.data.lines);
  if (!calculated.ok) return calculated;
  const totals = checkInvoiceTotals(checked.data, calculated.data);
  if (!totals.ok) return totals;
  const xml = writeInvoiceXml(checked.data, calculated.data);
  return ok({ format: invoiceFormat, xml, bytes: new TextEncoder().encode(xml) });
}

async function parsePdf(bytes: Uint8Array, options: InvoicePdfOptions = {}): Promise<FinanceResult<ParsedInvoice & { filename: string }>> {
  const { maxPdfBytes = 25 * 1024 * 1024, ...xmlOptions } = options;
  if (!Number.isSafeInteger(maxPdfBytes) || maxPdfBytes < 1) return invalid([{ code: "invalid_input", path: ["options", "maxPdfBytes"], message: "Expected a positive safe integer limit." }]);
  if (!(bytes instanceof Uint8Array)) return invalid([{ code: "invalid_input", path: ["pdf"], message: "Expected PDF bytes." }]);
  if (bytes.byteLength > maxPdfBytes) return invalid([{ code: "input_limit", path: ["pdf"], message: "PDF exceeds maxPdfBytes." }]);
  let pdfModule: typeof import("./einvoice-pdf");
  try { pdfModule = await import("./einvoice-pdf"); }
  catch { return invalid([{ code: "validator_unavailable", path: ["pdf"], message: "PDF invoice reading requires pdf-lib@1.17.1." }], true); }
  const { extractInvoiceXml } = pdfModule;
  const extracted = await extractInvoiceXml(bytes, xmlOptions);
  if (!extracted.ok) return extracted;
  const parsed = parseInvoiceXml(extracted.data.xml, xmlOptions);
  return parsed.ok ? ok({ ...parsed.data, filename: extracted.data.filename }) : parsed;
}

export const einvoice = {
  validate: (input: unknown): FinanceResult<Invoice> => validate(invoiceSchema, input),
  calculate: calculateInvoice,
  serialize,
  parseXml: parseInvoiceXml,
  parsePdf,
};
