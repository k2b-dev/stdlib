import Big from "big.js";
import { isValidIBAN } from "ibantools";
import { z } from "zod";
import { invalid, validate, type FinanceResult, type FinanceIssue } from "./common";
import { isInvoiceCountry, hasVatCountryPrefix } from "./einvoice-codes";
import { ok } from "../result";

export const invoiceFormat = "zugferd-2.5-en16931" as const;
export type InvoiceFormat = typeof invoiceFormat;
const Decimal = Big();
const text = (max: number) => z.string().min(1).max(max).refine(value =>
  value.trim().length > 0 && !/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(value), "Expected XML 1.0 text.");
const decimal = z.string().max(200).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/);
const amount = z.string().max(410).regex(/^(?:0|[1-9]\d*)\.\d{2}$/);
const rate = decimal.pipe(z.string().refine(value => new Decimal(value).gt(0) && new Decimal(value).lte(100), "Expected VAT rate > 0 and <= 100."));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !value.startsWith("0000-") && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date.");
const party = z.strictObject({
  name: text(200), vatId: text(100).refine(hasVatCountryPrefix, "Expected a VAT identifier with a country prefix (BR-CO-09)."),
  address: z.strictObject({ line1: text(200), city: text(100), postalCode: text(20), countryCode: z.string().refine(isInvoiceCountry, "Unsupported invoice country code (BR-CL-14/15).") }),
});
export const invoiceLineSchema = z.strictObject({
  id: text(100), name: text(200), description: text(4000).optional(),
  quantity: decimal.pipe(z.string().refine(value => new Decimal(value).gt(0), "Expected positive quantity.")),
  unitPrice: decimal, unitCode: z.enum(["C62", "HUR", "DAY", "KGM"]), taxRate: rate,
  netAmount: amount.optional(),
});
const linesSchema = z.array(invoiceLineSchema).min(1).max(1000).superRefine((lines, ctx) => {
  const ids = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (ids.has(line.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate line ID." });
    ids.add(line.id);
  }
});
const totalsSchema = z.strictObject({
  netAmount: amount, taxAmount: amount, grossAmount: amount, dueAmount: amount,
  taxGroups: z.array(z.strictObject({ taxRate: rate, netAmount: amount, taxAmount: amount })).min(1).max(1000),
});
export const invoiceSchema = z.strictObject({
  kind: z.enum(["invoice", "creditNote", "selfBilling"]), number: text(100), invoiceDate: date,
  serviceDate: date, dueDate: date, currency: z.literal("EUR"), seller: party, buyer: party,
  buyerReference: text(100), notes: z.array(text(4000)).max(100).optional(),
  precedingInvoice: z.strictObject({ number: text(100), invoiceDate: date }).optional(),
  payment: z.strictObject({ iban: z.string().refine(isValidIBAN, "Invalid IBAN."), accountName: text(200) }),
  lines: linesSchema, totals: totalsSchema.optional(),
}).superRefine((invoice, ctx) => {
  if (invoice.dueDate < invoice.invoiceDate) ctx.addIssue({ code: "custom", path: ["dueDate"], message: "Must not precede invoiceDate." });
  if (invoice.kind === "creditNote" && !invoice.precedingInvoice) ctx.addIssue({ code: "custom", path: ["precedingInvoice"], message: "Credit notes require an original invoice." });
  if (invoice.precedingInvoice && (invoice.kind !== "creditNote" || invoice.precedingInvoice.invoiceDate > invoice.invoiceDate)) ctx.addIssue({ code: "custom", path: ["precedingInvoice"], message: "Only credit notes may reference an earlier invoice." });
});
export type Invoice = z.infer<typeof invoiceSchema>;
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;
export type InvoiceTotals = z.infer<typeof totalsSchema>;
export type InvoiceCalculation = InvoiceTotals & { lines: (InvoiceLine & { netAmount: string })[] };
export type InvoiceXmlFile = { format: InvoiceFormat; xml: string; bytes: Uint8Array };
export type ParsedInvoice = { format: InvoiceFormat; profile: string; xml: string; invoice: Invoice; filename?: string };
export type InvoiceParseOptions = { maxCharacters?: number; maxElements?: number; maxDepth?: number };
export type InvoicePdfOptions = InvoiceParseOptions & { maxPdfBytes?: number };

/** Round each line, then VAT per rate, half up to cents. Never use binary floating point. */
export function calculateInvoice(lines: readonly InvoiceLine[]): FinanceResult<InvoiceCalculation> {
  const checked = validate(linesSchema, lines);
  if (!checked.ok) return checked;
  const calculated = checked.data.map(line => ({ ...line, netAmount: new Decimal(line.quantity).times(line.unitPrice).toFixed(2, 1) }));
  const groups = new Map<string, { taxRate: string; basis: Big }>();
  for (const line of calculated) {
    const key = new Decimal(line.taxRate).toString();
    const previous = groups.get(key);
    groups.set(key, { taxRate: previous?.taxRate ?? line.taxRate, basis: (previous?.basis ?? new Decimal(0)).plus(line.netAmount) });
  }
  const taxGroups = [...groups.values()].map(group => ({ taxRate: group.taxRate, netAmount: group.basis.toFixed(2), taxAmount: group.basis.times(group.taxRate).times("0.01").toFixed(2, 1) }));
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
    const expected = new Map(calculated.taxGroups.map(group => [new Decimal(group.taxRate).toString(), group]));
    const seen = new Set<string>();
    for (const [index, group] of actual.taxGroups.entries()) {
      const key = new Decimal(group.taxRate).toString();
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
