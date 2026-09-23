import Big from "big.js";
import { isValidIBAN } from "ibantools";
import { z } from "zod";
import { invalid, validate, type FinanceResult, type FinanceIssue } from "./common";
import { isInvoiceCountry, hasVatCountryPrefix, isVatExemptionCode, vatExemptionCategory } from "./einvoice-codes";
import { ok } from "../result";

export const invoiceFormat = "zugferd-2.5-en16931" as const;
export type InvoiceFormat = typeof invoiceFormat;
const Decimal = Big();
const text = (max: number) => z.string().min(1).max(max).refine(value =>
  value.trim().length > 0 && !/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(value), "Expected XML 1.0 text.");
const decimal = z.string().max(200).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/);
const amount = z.string().max(410).regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
const rate = decimal.pipe(z.string().refine(value => new Decimal(value).lte(100), "Expected VAT rate >= 0 and <= 100."));
const taxFields = {
  taxCategory: z.enum(["S", "Z", "E", "AE", "K", "G", "O"]).optional(), taxRate: rate,
  taxExemptionReason: text(4000).optional(),
  taxExemptionReasonCode: text(100).refine(isVatExemptionCode, "Expected a VATEX code (BR-CL-22).").optional(),
};
type Tax = z.infer<z.ZodObject<typeof taxFields>>;
export type InvoiceTaxCategory = NonNullable<Tax["taxCategory"]>;
export const invoiceTaxKey = (tax: Pick<Tax, "taxCategory" | "taxRate">): string => `${tax.taxCategory ?? "S"}:${new Decimal(tax.taxRate).toString()}`;
const reasonFields = ["taxExemptionReason", "taxExemptionReasonCode"] as const;
function checkTax(tax: Tax, ctx: z.RefinementCtx) {
  const category = tax.taxCategory ?? "S";
  // Refinements can run after a dirty string check; do not pass malformed input to Big.
  if (/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(tax.taxRate) && (category === "S" ? new Decimal(tax.taxRate).eq(0) : !new Decimal(tax.taxRate).eq(0))) {
    ctx.addIssue({ code: "custom", path: ["taxRate"], message: category === "S" ? "S requires a positive VAT rate (BR-S-05/07)." : "This category requires a zero API taxRate; O omits the XML rate (BR-E/Z/AE/IC/G-05, BR-O-05)." });
  }
  for (const field of reasonFields) if ((category === "S" || category === "Z") && tax[field] !== undefined) {
    ctx.addIssue({ code: "custom", path: [field], message: "S and Z forbid exemption reasons (BR-S-10, BR-Z-10)." });
  }
  if (tax.taxExemptionReasonCode && vatExemptionCategory(tax.taxExemptionReasonCode) !== category) {
    ctx.addIssue({ code: "custom", path: ["taxExemptionReasonCode"], message: "VATEX code does not match the VAT category." });
  }
}
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !value.startsWith("0000-") && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date.");
const party = z.strictObject({
  name: text(200), id: text(100).optional(),
  // Preserve the existing required string contract; empty means no VAT registration.
  vatId: z.union([z.literal(""), text(100).refine(hasVatCountryPrefix, "Expected a VAT identifier with a country prefix (BR-CO-09).")]),
  address: z.strictObject({ line1: text(200), city: text(100), postalCode: text(20), countryCode: z.string().refine(isInvoiceCountry, "Unsupported invoice country code (BR-CL-14/15).") }),
});
export const invoiceLineSchema = z.strictObject({
  id: text(100), name: text(200), description: text(4000).optional(),
  quantity: decimal.pipe(z.string().refine(value => new Decimal(value).gt(0), "Expected positive quantity.")),
  unitPrice: decimal, unitCode: z.enum(["C62", "HUR", "DAY", "KGM"]), ...taxFields,
  netAmount: amount.optional(),
}).superRefine(checkTax);
const linesSchema = z.array(invoiceLineSchema).min(1).max(1000).superRefine((lines, ctx) => {
  const ids = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (ids.has(line.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate line ID." });
    ids.add(line.id);
  }
  if (lines.some(line => line.taxCategory === "O") && lines.some(line => line.taxCategory !== "O")) ctx.addIssue({ code: "custom", path: [], message: "O cannot be mixed with other categories (BR-O-12)." });
});
const totalsSchema = z.strictObject({
  netAmount: amount, taxAmount: amount, grossAmount: amount, dueAmount: amount,
  taxGroups: z.array(z.strictObject({ ...taxFields, netAmount: amount, taxAmount: amount }).superRefine((group, ctx) => {
    checkTax(group, ctx);
    if ((group.taxCategory ?? "S") !== "S" && /^\d+\.\d{2}$/.test(group.taxAmount) && !new Decimal(group.taxAmount).eq(0)) ctx.addIssue({ code: "custom", path: ["taxAmount"], message: "Non-S tax amounts must be zero (BR-E/Z/O/AE/IC/G-09)." });
  })).min(1).max(1000),
});
export const invoiceSchema = z.strictObject({
  kind: z.enum(["invoice", "creditNote", "selfBilling"]), number: text(100), invoiceDate: date,
  serviceDate: date, dueDate: date, currency: z.literal("EUR"),
  seller: party.extend({ taxRegistrationId: text(100).optional() }), buyer: party,
  deliverToCountryCode: z.string().refine(isInvoiceCountry, "Unsupported delivery country (BR-CL-15).").optional(),
  buyerReference: text(100), notes: z.array(text(4000)).max(100).optional(),
  precedingInvoice: z.strictObject({ number: text(100), invoiceDate: date }).optional(),
  payment: z.strictObject({ iban: z.string().refine(isValidIBAN, "Invalid IBAN."), accountName: text(200) }),
  lines: linesSchema, totals: totalsSchema.optional(),
}).superRefine((invoice, ctx) => {
  if (invoice.dueDate < invoice.invoiceDate) ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Must not precede invoiceDate." });
  if (invoice.kind === "creditNote" && !invoice.precedingInvoice) ctx.addIssue({ code: "custom", path: ["precedingInvoice"], message: "Credit notes require an original invoice." });
  if (invoice.precedingInvoice && (invoice.kind !== "creditNote" || invoice.precedingInvoice.invoiceDate > invoice.invoiceDate)) ctx.addIssue({ code: "custom", path: ["precedingInvoice"], message: "Only credit notes may reference an earlier invoice." });
  const taxes = [...invoice.lines, ...(invoice.totals?.taxGroups ?? [])];
  const categories = new Set(taxes.map(tax => tax.taxCategory ?? "S"));
  if (!invoice.seller.vatId && !invoice.seller.id) ctx.addIssue({ code: "custom", path: ["seller", "id"], message: "Seller identifier required when no VAT ID is supplied (BR-CO-26)." });
  if (categories.has("O")) {
    if (categories.size !== 1) ctx.addIssue({ code: "custom", path: ["lines"], message: "O cannot be mixed with other categories (BR-O-11/12)." });
    for (const name of ["seller", "buyer"] as const) if (invoice[name].vatId) ctx.addIssue({ code: "custom", path: [name, "vatId"], message: "O forbids VAT identifiers; use an empty vatId (BR-O-02)." });
  } else {
    if (!invoice.seller.vatId && (!invoice.seller.taxRegistrationId || categories.has("K") || categories.has("G"))) ctx.addIssue({ code: "custom", path: ["seller", "vatId"], message: "Seller VAT ID required for K/G; other categories require VAT ID or tax registration (BR-S/E/Z/AE/IC/G-02)." });
    if ((categories.has("AE") || categories.has("K")) && !invoice.buyer.vatId) ctx.addIssue({ code: "custom", path: ["buyer", "vatId"], message: "Buyer VAT ID required for AE/K in this slice (BR-AE/IC-02)." });
  }
  if (categories.has("K") && !invoice.deliverToCountryCode) ctx.addIssue({ code: "custom", path: ["deliverToCountryCode"], message: "K requires the delivery country (BR-IC-12)." });
  // Shape/rate errors already have precise paths. Group matching requires valid decimals.
  if (!taxes.every(tax => /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(tax.taxRate))) return;
  if (invoice.totals) {
    const expected = new Set(invoice.lines.map(invoiceTaxKey));
    const seen = new Set<string>();
    for (const [index, group] of invoice.totals.taxGroups.entries()) {
      const key = invoiceTaxKey(group);
      if (seen.has(key) || !expected.has(key)) ctx.addIssue({ code: "custom", path: ["totals", "taxGroups", index, "taxRate"], message: "Duplicate or unexpected tax group (BR-S/E/Z/O/AE/IC/G-01)." });
      seen.add(key);
    }
    if ([...expected].some(key => !seen.has(key))) ctx.addIssue({ code: "custom", path: ["totals", "taxGroups"], message: "Missing calculated tax group (BR-S/E/Z/O/AE/IC/G-01)." });
  }
  const groups = new Map<string, Tax>();
  for (const [index, tax] of taxes.entries()) {
    const path = index < invoice.lines.length ? ["lines", index] : ["totals", "taxGroups", index - invoice.lines.length];
    const key = invoiceTaxKey(tax);
    const previous = groups.get(key);
    for (const field of reasonFields) if (previous?.[field] !== undefined && tax[field] !== undefined && previous[field] !== tax[field]) ctx.addIssue({ code: "custom", path: [...path, field], message: "Conflicting exemption reasons within one category/rate group; provide one shared group reason." });
    groups.set(key, { ...tax, ...Object.fromEntries(reasonFields.flatMap(field => previous?.[field] !== undefined ? [[field, previous[field]]] : [])) });
  }
  for (const [key, tax] of groups) if (!["S", "Z"].includes(tax.taxCategory ?? "S") && !tax.taxExemptionReason && !tax.taxExemptionReasonCode) ctx.addIssue({ code: "custom", path: ["totals", "taxGroups"], message: `Tax group ${key} requires an exemption reason or VATEX code (BR-E/O/AE/IC/G-10).` });
});
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export type InvoiceTotals = z.infer<typeof totalsSchema>;
export type InvoiceCalculation = InvoiceTotals & { lines: (InvoiceLine & { netAmount: string })[] };
export type InvoiceXmlFile = { format: InvoiceFormat; xml: string; bytes: Uint8Array };
export type ParsedInvoice = { format: InvoiceFormat; profile: string; xml: string; invoice: Invoice; filename?: string };
export type InvoiceParseOptions = { maxCharacters?: number; maxElements?: number; maxDepth?: number };
export type InvoicePdfOptions = InvoiceParseOptions & { maxPdfBytes?: number };

/** Round each line, then VAT per category/rate, half up to cents. Never use binary floating point. */
export function calculateInvoice(lines: readonly InvoiceLine[]): FinanceResult<InvoiceCalculation> {
  const checked = validate(linesSchema, lines);
  if (!checked.ok) return checked;
  const calculated = checked.data.map(line => ({ ...line, netAmount: new Decimal(line.quantity).times(line.unitPrice).toFixed(2, 1) }));
  const groups = new Map<string, Tax & { basis: Big }>();
  for (const line of calculated) {
    const key = invoiceTaxKey(line);
    const previous = groups.get(key);
    for (const field of reasonFields) if (previous?.[field] !== undefined && line[field] !== undefined && previous[field] !== line[field]) return invalid([{ code: "invalid_input", path: ["lines", calculated.indexOf(line), field], message: "Conflicting exemption reasons within one category/rate group." }]);
    groups.set(key, { taxRate: previous?.taxRate ?? line.taxRate,
      ...(line.taxCategory !== undefined ? { taxCategory: line.taxCategory } : {}),
      ...Object.fromEntries(reasonFields.flatMap(field => (previous?.[field] ?? line[field]) !== undefined ? [[field, previous?.[field] ?? line[field]]] : [])),
      basis: (previous?.basis ?? new Decimal(0)).plus(line.netAmount) });
  }
  const taxGroups = [...groups.values()].map(({ basis, ...tax }) => ({ ...tax, netAmount: basis.toFixed(2), taxAmount: basis.times(tax.taxRate).times("0.01").toFixed(2, 1) }));
  const net = calculated.reduce((sum, line) => sum.plus(line.netAmount), new Decimal(0));
  const tax = taxGroups.reduce((sum, group) => sum.plus(group.taxAmount), new Decimal(0));
  return ok({ lines: calculated, taxGroups, netAmount: net.toFixed(2), taxAmount: tax.toFixed(2), grossAmount: net.plus(tax).toFixed(2), dueAmount: net.plus(tax).toFixed(2) });
}

/** Check declared amounts before generation. Parsing deliberately preserves them without recalculation. */
export function checkInvoiceTotals(invoice: Invoice, calculated: InvoiceCalculation): FinanceResult<void> {
  const issues: FinanceIssue[] = invoice.lines.flatMap((line, index) => line.netAmount !== undefined && line.netAmount !== calculated.lines[index]?.netAmount
    ? [{ code: "invalid_input" as const, path: ["lines", index, "netAmount"], message: "Declared line amount differs from calculated amount." }] : []);
  if (invoice.totals) {
    const actual = invoice.totals;
    for (const key of ["netAmount", "taxAmount", "grossAmount", "dueAmount"] as const) {
      if (actual[key] !== calculated[key]) issues.push({ code: "invalid_input", path: ["totals", key], message: "Declared total differs from calculated amount." });
    }
    const expected = new Map(calculated.taxGroups.map(group => [invoiceTaxKey(group), group]));
    const seen = new Set<string>();
    for (const [index, group] of actual.taxGroups.entries()) {
      const key = invoiceTaxKey(group);
      const match = expected.get(key);
      if (seen.has(key) || !match) issues.push({ code: "invalid_input", path: ["totals", "taxGroups", index, "taxRate"], message: "Duplicate or unexpected tax group." });
      seen.add(key);
      if (match) for (const field of ["netAmount", "taxAmount"] as const) {
        if (group[field] !== match[field]) issues.push({ code: "invalid_input", path: ["totals", "taxGroups", index, field], message: "Declared tax group amount differs from calculated amount." });
      }
    }
    if ([...expected.keys()].some(key => !seen.has(key))) issues.push({ code: "invalid_input", path: ["totals", "taxGroups"], message: "Missing calculated tax group." });
  }
  // A supported output boundary, not an EN16931 legal maximum. The official
  // Schematron uses floating-point arithmetic in some sum checks at extreme scales.
  for (const [index, line] of calculated.lines.entries()) {
    if (new Decimal(line.netAmount).gt("9999999999.99")) issues.push({ code: "invalid_input", path: ["lines", index, "netAmount"], message: "Calculated amount exceeds the supported maximum 9999999999.99." });
  }
  if (new Decimal(calculated.grossAmount).gt("9999999999.99")) issues.push({ code: "invalid_input", path: ["totals", "grossAmount"], message: "Calculated total exceeds the supported maximum 9999999999.99." });
  return issues.length ? invalid(issues) : ok();
}
