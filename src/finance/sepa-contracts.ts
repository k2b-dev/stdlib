import { isSEPACountry, isValidBIC, isValidIBAN } from "ibantools";
import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cs}]*$/u)
    .refine(value => !/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value), "Invalid XML character.");
const iban = z
  .string()
  .max(34)
  .regex(/^[A-Z]{2}\d{2}[A-Z0-9]+$/)
  .refine(
    (value) => isValidIBAN(value, { allowQRIBAN: false }) && isSEPACountry(value.slice(0, 2)),
    "Use a valid SEPA IBAN, not a QR-IBAN.",
  );
const bic = z.string().max(11).refine(isValidBIC, "Invalid BIC.");
const basicSepaCharacters = /^[A-Za-z0-9+?/:().,' -]+$/;
const paymentId = z
  .string()
  .min(1)
  .max(35)
  .regex(basicSepaCharacters)
  .refine((value) => !value.startsWith("/") && !value.endsWith("/") && !value.includes("//"), "Invalid payment identifier.");

export const SepaTransferSchema = z
  .object({
    endToEndId: paymentId,
    amount: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,8})\.\d{2}$/)
      .refine((value) => /[1-9]/.test(value), "Amount must be positive."),
    creditorName: text(70),
    creditorIban: iban,
    creditorBic: bic.optional(),
    remittance: text(140),
  })
  .strict();

export const SepaHeaderSchema = z
  .object({
    format: z.literal("sepa-sct-pain.001.001.09-gbic-5"),
    currency: z.literal("EUR"),
    createdAt: z.iso.datetime({ precision: 3 }).refine(value => !value.startsWith("0000-"), "XML Schema dates require a nonzero year."),
    debtorName: text(70),
    debtorIban: iban,
    debtorBic: bic.optional(),
    executionDate: z.iso.date().refine(value => !value.startsWith("0000-"), "XML Schema dates require a nonzero year."),
  })
  .strict();

export const SepaBatchSchema = SepaHeaderSchema.extend({
  messageId: paymentId,
  paymentInformationId: paymentId,
  rows: z.array(SepaTransferSchema).min(1),
}).superRefine((input, ctx) => {
  const seen = new Set<string>();
  input.rows.forEach((row, index) => {
    if (seen.has(row.endToEndId)) ctx.addIssue({ code: "custom", path: ["rows", index, "endToEndId"], message: "Duplicate end-to-end identifier." });
    seen.add(row.endToEndId);
  });
});

export type SepaTransfer = z.infer<typeof SepaTransferSchema>;
export type SepaBatch = z.infer<typeof SepaBatchSchema>;
