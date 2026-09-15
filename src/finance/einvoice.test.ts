import { describe, expect, test } from "bun:test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { invoice as sample } from "../../examples/einvoice";
import { einvoice, type Invoice } from "./index";
import { validateInvoiceXml } from "./validate";
import { unwrap } from "../result";
const format = "zugferd-2.5-en16931";
const xml = (invoice: Invoice = sample) => unwrap(einvoice.serialize(invoice, { format })).xml;

for (const kind of ["invoice", "creditNote", "selfBilling"] as const) {
  test(`${kind}: generate, validate XSD, parse without losing decimals`, async () => {
    const input: Invoice = { ...sample, kind, notes: ["Terms & conditions <agreed>\r\n✓"], ...(kind === "creditNote" ? { precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-01" } } : {}) };
    const source = xml(input);
    expect(await validateInvoiceXml(source, { format })).toEqual({ ok: true, data: undefined });
    const parsed = unwrap(einvoice.parseXml(source));
    expect(parsed.xml).toBe(source);
    expect(parsed.invoice).toMatchObject(input);
    expect(parsed.invoice.totals).toMatchObject({ netAmount: "120.00", taxAmount: "20.40", grossAmount: "140.40" });
    expect(xml(parsed.invoice)).toBe(source);
  });
}

test("half-cent unit prices stay exact and agree with rounded line and tax-group totals", () => {
  const input = { ...sample, lines: Array.from({ length: 3 }, (_, index) => ({ ...sample.lines[0]!, id: String(index + 1), quantity: "1.0000", unitPrice: "1.0050" })) };
  const parsed = unwrap(einvoice.parseXml(xml(input))).invoice;
  expect(parsed.lines[0]?.unitPrice).toBe("1.0050");
  expect(parsed.lines.map(line => line.netAmount)).toEqual(["1.01", "1.01", "1.01"]);
  expect(parsed.totals).toMatchObject({ netAmount: "3.03", taxAmount: "0.58", grossAmount: "3.61" });
});

test("amounts beyond Number precision and equivalent VAT rates", () => {
  const first = { ...sample.lines[0]!, quantity: "1", unitPrice: "9007199254740993.0050", taxRate: "19" };
  const totals = unwrap(einvoice.calculate([first, { ...first, id: "2", unitPrice: "0", taxRate: "19.00" }]));
  expect(totals.netAmount).toBe("9007199254740993.01");
  expect(totals.taxGroups).toHaveLength(1);
  expect(unwrap(einvoice.parseXml(xml({ ...sample, lines: [first] }))).invoice.lines[0]?.unitPrice).toBe(first.unitPrice);
});

test("parsing preserves declared inconsistent sums; generation rejects them", () => {
  const source = xml().replace("<ram:GrandTotalAmount>140.40", "<ram:GrandTotalAmount>999.00");
  const parsed = unwrap(einvoice.parseXml(source));
  expect(parsed.invoice.totals?.grossAmount).toBe("999.00");
  expect(einvoice.serialize(parsed.invoice, { format }).ok).toBe(false);
  expect(einvoice.serialize({ ...sample, lines: [{ ...sample.lines[0]!, netAmount: "1.00" }] }, { format }).ok).toBe(false);
});

test("prefixes, comments, CDATA and UTF-8 BOM do not change namespace semantics", () => {
  const source = '\uFEFF' + xml().replaceAll("ram:", "a:").replace("xmlns:ram=", "xmlns:a=").replace("Consulting", "<![CDATA[Consulting]]>").replace("<rsm:ExchangedDocument>", "<!-- comment --><rsm:ExchangedDocument>");
  expect(unwrap(einvoice.parseXml(source)).invoice.lines[0]?.name).toBe("Consulting");
});

describe("reject unsafe, ambiguous and unsupported input", () => {
  const transforms = [
    (s: string) => s.replace("<ram:Name>Consulting", "<ram:Name>Consulting</ram:Name><ram:Name>Second"),
    (s: string) => s.replace("<ram:InvoiceCurrencyCode>EUR", "<ram:InvoiceCurrencyCode>USD"),
    (s: string) => s.replace("<ram:CategoryCode>S", "<ram:CategoryCode>E"),
    (s: string) => s.replace("<ram:NetPriceProductTradePrice>", "<ram:NetPriceProductTradePrice><ram:BasisQuantity>100</ram:BasisQuantity>"),
    (s: string) => s.replace("<ram:ChargeTotalAmount>0.00", "<ram:ChargeTotalAmount>1.00"),
    (s: string) => s.replace("<ram:Name>Consulting", '<ram:Name xmlns:ram="urn:spoof">Consulting'),
    (s: string) => s.replace("<ram:Name>Consulting", '<ram:Name currencyID="USD">Consulting'),
    (s: string) => s.replace("<rsm:CrossIndustryInvoice", '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><rsm:CrossIndustryInvoice'),
    (s: string) => s.replace("Consulting", "&unknown;"),
    (s: string) => s + "<extra/>",
    (s: string) => s.slice(0, -1),
    (s: string) => s.replace("urn:cen.eu:en16931:2017", "urn:xeinkauf.de:kosit:xrechnung_3.0"),
  ];
  for (const [index, transform] of transforms.entries()) test(`XML case ${index}`, () => expect(einvoice.parseXml(transform(xml())).ok).toBe(false));
  test("limits", () => {
    for (const options of [{ maxCharacters: 1 }, { maxElements: 1 }, { maxDepth: 1 }, { maxDepth: 0 }]) expect(einvoice.parseXml(xml(), options).ok).toBe(false);
  });
  test("input validation", () => {
    for (const input of [null, { ...sample, invoiceDate: "2026-02-31" }, { ...sample, number: "bad\0" }, { ...sample, number: "bad\ud800" }, { ...sample, extra: true }, { ...sample, kind: "creditNote" }, { ...sample, lines: [sample.lines[0], sample.lines[0]] }, { ...sample, lines: [{ ...sample.lines[0], unitPrice: 1.5 }] }]) expect(einvoice.validate(input).ok).toBe(false);
  });
});

test("XSD rejection and repeated concurrent validation", async () => {
  expect((await validateInvoiceXml(xml().replace("<ram:GrandTotalAmount>140.40", "<ram:GrandTotalAmount>abc"), { format })).ok).toBe(false);
  const results = await Promise.all(Array.from({ length: 8 }, () => validateInvoiceXml(xml(), { format })));
  expect(results.every(result => result.ok)).toBe(true);
});

async function pdfWithInvoice(source = xml(), filename = "factur-x.xml") {
  const pdf = await PDFDocument.create(); pdf.addPage();
  await pdf.attach(new TextEncoder().encode(source), filename, { mimeType: "application/xml" });
  return pdf;
}

test("real compressed PDF attachment round trip and nested name tree", async () => {
  const pdf = await pdfWithInvoice();
  const bytes = await pdf.save();
  expect(unwrap(await einvoice.parsePdf(bytes)).invoice.number).toBe(sample.number);
  const loaded = await PDFDocument.load(bytes);
  const names = loaded.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict);
  const child = loaded.context.obj({ Names: names.lookup(PDFName.of("Names"), PDFArray) });
  names.delete(PDFName.of("Names")); names.set(PDFName.of("Kids"), loaded.context.obj([child]));
  expect(unwrap(await einvoice.parsePdf(await loaded.save())).filename).toBe("factur-x.xml");
});

test("PDF rejects absent, duplicate, oversized and invalid XML attachments", async () => {
  const empty = await PDFDocument.create(); empty.addPage();
  expect((await einvoice.parsePdf(await empty.save())).ok).toBe(false);
  const pdf = await pdfWithInvoice();
  await pdf.attach(new TextEncoder().encode(xml()), "zugferd-invoice.xml");
  expect((await einvoice.parsePdf(await pdf.save())).ok).toBe(false);
  const bytes = await (await pdfWithInvoice()).save();
  expect((await einvoice.parsePdf(bytes, { maxPdfBytes: 1 })).ok).toBe(false);
  expect((await einvoice.parsePdf(bytes, { maxCharacters: 1 })).ok).toBe(false);
  expect((await einvoice.parsePdf(new Uint8Array([1, 2, 3]))).ok).toBe(false);
});

test("reads independent Cloud / Factur-X 1.2.0 output", async () => {
  const source = await Bun.file(new URL("../../examples/fixtures/einvoice/cloud-factur-x-1.2.0.xml", import.meta.url)).text();
  const parsed = unwrap(einvoice.parseXml(source));
  expect(parsed.invoice.number).toBe(sample.number);
  expect(parsed.invoice.totals?.grossAmount).toBe("140.40");
  expect(await validateInvoiceXml(source, { format })).toEqual({ ok: true, data: undefined });
});

test("XSD entry point rejects another guideline and DTD before WASM", async () => {
  const source = xml();
  for (const value of [source.replace("urn:cen.eu:en16931:2017", "urn:other"), source.replace("<rsm:CrossIndustryInvoice", "<!DOCTYPE x><rsm:CrossIndustryInvoice")]) {
    expect((await validateInvoiceXml(value, { format })).ok).toBe(false);
  }
});

test("large allowed decimal inputs still serialize to readable totals", () => {
  const large = "9".repeat(200);
  const source = xml({ ...sample, lines: [{ ...sample.lines[0]!, quantity: large, unitPrice: large }] });
  expect(einvoice.parseXml(source).ok).toBe(true);
});

test("malformed and oversized numeric strings return errors instead of throwing", () => {
  for (const value of ["NaN", "Infinity", "1e999999999", "", "-1", "9".repeat(201)]) {
    for (const field of ["quantity", "unitPrice", "taxRate"] as const) {
      const lines = [{ ...sample.lines[0]!, [field]: value }];
      expect(einvoice.validate({ ...sample, lines }).ok).toBe(false);
      expect(einvoice.calculate(lines).ok).toBe(false);
      expect(einvoice.serialize({ ...sample, lines }, { format }).ok).toBe(false);
    }
  }
});
