import Big from "big.js";
import { ok } from "../result";
import { invalid, validate, type FinanceResult } from "./common";
import {
  DatevXmlPackageSchema, checkDatevXmlPackage, datevXmlLimits, ledgerFileName,
  type DatevXmlCash, type DatevXmlDocument, type DatevXmlPackage,
} from "./datev-xml-contracts";
import { zipStore, zipStoreSize, type ZipStoreEntry } from "./zip-store";

const documentNamespace = "http://xml.datev.de/bedi/tps/document/v06.0";
const ledgerNamespace = "http://xml.datev.de/bedi/tps/ledger/v060";
const xsiNamespace = "http://www.w3.org/2001/XMLSchema-instance";
// Fixed value required by the ledger XSD (`xml_data`).
const xmlData = "Kopie nur zur Verbuchung berechtigt nicht zum Vorsteuerabzug";
const Decimal = Big();
/** consolidatedAmount (de:p10002) allows at most ten integer digits by pattern. */
const maxTotal = new Decimal("9999999999.99");

export type DatevXmlFileDocument = {
  /** Name of the generated ledger data file inside the ZIP. */
  dataFile: string;
  /** The ledger data file as written into the ZIP. */
  xml: string;
  /** `consolidatedAmount`: exact signed sum of all lines. */
  amount: string;
  /** Attached file names in ZIP order. */
  files: string[];
};

export type DatevXmlFile = {
  /** ZIP for DATEV Belegtransfer: document.xml, then each data file followed by its files. */
  bytes: Uint8Array;
  /** The administrative file `document.xml` as written into the ZIP. */
  documentXml: string;
  documents: DatevXmlFileDocument[];
  lineCount: number;
};

// Inputs are checked against the DATEV repertoire before reaching this function.
const escape = (value: string) => value.replace(/[&<>"']/g, char => {
  switch (char) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    default: return "&apos;";
  }
});
const element = (indent: string, name: string, value: string | undefined) =>
  value === undefined ? "" : `${indent}<${name}>${escape(value)}</${name}>\n`;
const attribute = (name: string, value: string | undefined) => value === undefined ? "" : ` ${name}="${escape(value)}"`;

function ledgerXml(input: DatevXmlPackage, document: DatevXmlDocument, amount: string): string {
  const i = "      ";
  const rows = document.kind === "cashLedger"
    ? document.lines.map(line =>
      "    <cashLedger>\n" +
      element(i, "date", document.documentDate) + element(i, "amount", line.amount) +
      element(i, "accountNo", line.account) + element(i, "buCode", line.buCode) +
      element(i, "costCategoryId", line.costCenter1) + element(i, "costCategoryId2", line.costCenter2) +
      element(i, "tax", line.taxRate) + element(i, "information", line.information) +
      element(i, "currencyCode", input.currency) + element(i, "invoiceId", line.documentNumber) +
      element(i, "bookingText", line.text) +
      "    </cashLedger>\n")
    : document.lines.map(line => {
      const party = document.kind === "accountsPayableLedger" ? "supplier" : "customer";
      return `    <${document.kind}>\n` +
        element(i, "date", document.documentDate) + element(i, "amount", line.amount) +
        element(i, "accountNo", line.account) + element(i, "buCode", line.buCode) +
        element(i, "costCategoryId", line.costCenter1) + element(i, "costCategoryId2", line.costCenter2) +
        element(i, "tax", line.taxRate) + element(i, "information", line.information) +
        element(i, "currencyCode", input.currency) + element(i, "invoiceId", document.documentNumber) +
        element(i, "bookingText", line.text) + element(i, "partyId", document.partyId) +
        element(i, "paidAt", document.paidAt) + element(i, "vatId", document.vatId) +
        element(i, "iban", document.iban) + element(i, "swiftCode", document.bic) +
        element(i, "dueDate", document.dueDate) + element(i, "bpAccountNo", document.partyAccount) +
        element(i, "deliveryDate", document.deliveryDate) +
        element(i, `${party}Name`, document.partyName) + element(i, `${party}City`, document.partyCity) +
        `    </${document.kind}>\n`;
    });
  const invoice = document.kind === "cashLedger" ? undefined : document;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<LedgerImport xmlns="${ledgerNamespace}" xmlns:xsi="${xsiNamespace}" xsi:schemaLocation="${ledgerNamespace} Belegverwaltung_online_ledger_import_v060.xsd"` +
    ` version="6.0"${attribute("generator_info", input.generatorInfo)}${attribute("generating_system", input.generatingSystem)} xml_data="${xmlData}">\n` +
    `  <consolidate consolidatedAmount="${amount}" consolidatedDate="${document.documentDate}"` +
    `${attribute("consolidatedInvoiceId", invoice?.documentNumber)} consolidatedCurrencyCode="${input.currency}"` +
    `${attribute("consolidatedDeliveryDate", invoice?.deliveryDate)}>\n` +
    rows.join("") +
    "  </consolidate>\n</LedgerImport>\n";
}

function cashProperty(document: DatevXmlCash): string {
  return "accountNumber" in document.cashRegister
    ? `        <property key="2" value="${document.cashRegister.accountNumber}"/>\n`
    : `        <property key="3"${attribute("value", document.cashRegister.name)}/>\n`;
}

function documentXml(input: DatevXmlPackage): string {
  const documents = input.documents.map((document, index) =>
    `    <document${attribute("guid", document.guid)}>\n` +
    `      <extension xsi:type="${document.kind}" datafile="${ledgerFileName(index)}">\n` +
    `        <property key="1" value="${document.period}"/>\n` +
    (document.kind === "cashLedger" ? cashProperty(document) : `        <property key="3"${attribute("value", document.folder)}/>\n`) +
    "      </extension>\n" +
    document.files.map(file => `      <extension xsi:type="File"${attribute("name", file.name)}/>\n`).join("") +
    "    </document>\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<archive xmlns="${documentNamespace}" xmlns:xsi="${xsiNamespace}" xsi:schemaLocation="${documentNamespace} Document_v060.xsd"` +
    ` version="6.0"${attribute("generatingSystem", input.generatingSystem)}>\n` +
    "  <header>\n" + element("    ", "date", input.createdAt) + element("    ", "description", input.description) + "  </header>\n" +
    "  <content>\n" + documents.join("") + "  </content>\n</archive>\n";
}

/** Shape first, then rules across fields; untrusted input never reaches the cross-field checks. */
function validatePackage(input: unknown): FinanceResult<DatevXmlPackage> {
  const checked = validate(DatevXmlPackageSchema, input);
  if (!checked.ok) return checked;
  const issues = checkDatevXmlPackage(checked.data);
  return issues.length ? invalid(issues.map(issue => ({ code: "invalid_input", ...issue }))) : checked;
}

/** Validate inputs and build the Belegtransfer ZIP synchronously, without loading an XSD engine. */
function serialize(input: DatevXmlPackage): FinanceResult<DatevXmlFile> {
  const checked = validatePackage(input);
  if (!checked.ok) return checked;
  const data = checked.data;
  const totals = data.documents.map(document => document.lines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0)));
  const tooLarge = totals.flatMap((total, index) => total.abs().gt(maxTotal)
    ? [{ code: "input_limit" as const, path: ["documents", index, "lines"], message: "The sum of the lines exceeds DATEV's consolidated amount range of ±9999999999.99." }]
    : []);
  if (tooLarge.length) return invalid(tooLarge);
  const encoder = new TextEncoder();
  const documents = data.documents.map((document, index): DatevXmlFileDocument => {
    // Big keeps the sign of a negative zero; DATEV expects a plain 0.00.
    const amount = totals[index]!.eq(0) ? "0.00" : totals[index]!.toFixed(2);
    return { dataFile: ledgerFileName(index), xml: ledgerXml(data, document, amount), amount, files: document.files.map(file => file.name) };
  });
  const administrative = documentXml(data);
  const entries: ZipStoreEntry[] = [{ name: "document.xml", bytes: encoder.encode(administrative) }];
  data.documents.forEach((document, index) => {
    entries.push({ name: documents[index]!.dataFile, bytes: encoder.encode(documents[index]!.xml) });
    for (const file of document.files) entries.push({ name: file.name, bytes: file.bytes });
  });
  if (zipStoreSize(entries) > datevXmlLimits.packageBytes)
    return invalid([{ code: "input_limit", path: ["documents"], message: "The package exceeds DATEV's 465 MB limit; split it (DATEV recommends about 100 MB)." }]);
  return ok({
    bytes: zipStore(entries, data.createdAt),
    documentXml: administrative,
    documents,
    lineCount: data.documents.reduce((count, document) => count + document.lines.length, 0),
  });
}

export const datevXml = {
  validate: validatePackage,
  serialize,
};
