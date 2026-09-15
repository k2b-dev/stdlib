/** Independent CI checks. Requires Java 11+ and Python 3; no runtime package dependency. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoice } from "../examples/einvoice";
import { datevExample, sepaExample } from "../examples/finance";
import { datev, sepa, einvoice, type Invoice } from "../src/finance";
import { validateInvoiceXml, validateSepaXml } from "../src/finance/validate";
import { unwrap } from "../src/result";

const artifacts = [
  { name: "saxon.jar", url: "https://repo.maven.apache.org/maven2/net/sf/saxon/Saxon-HE/10.9/Saxon-HE-10.9.jar", sha256: "491d8edf4ec811d15c2b2417b007218b9b938f15e4dfbad004025beb4e70e960" },
  { name: "cii.xslt", url: "https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/validation-1.3.16/cii/xslt/EN16931-CII-validation.xslt", sha256: "0b234dea2bbfee739b7761e607a992c17fab88773014ef56355b6158cfb1cc53" },
];
const cache = join(tmpdir(), "stdlib-finance-conformance");
await mkdir(cache, { recursive: true });
for (const artifact of artifacts) {
  const path = join(cache, artifact.sha256 + "-" + artifact.name);
  if (!await Bun.file(path).exists()) {
    const response = await fetch(artifact.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Download failed: ${artifact.url}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(`Integrity failure: ${artifact.name}`);
    await Bun.write(path, bytes);
  }
  if (new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex") !== artifact.sha256) throw new Error(`Cached integrity failure: ${artifact.name}`);
}
const work = await mkdtemp(join(tmpdir(), "stdlib-finance-cases-"));
try {
  await mkdir(join(work, "invoices"));
  await mkdir(join(work, "reports"));
  const cases: Record<string, Invoice> = {};
  for (const kind of ["invoice", "creditNote", "selfBilling"] as const) {
    cases[kind] = { ...invoice, kind, ...(kind === "creditNote" ? { precedingInvoice: { number: "ORIGINAL", invoiceDate: "2026-08-01" } } : {}) };
  }
  const line = invoice.lines[0]!;
  cases.rounding = { ...invoice, lines: Array.from({ length: 3 }, (_, i) => ({ ...line, id: String(i), quantity: "1.0000", unitPrice: "1.0050" })) };
  cases.units = { ...invoice, lines: (["C62", "HUR", "DAY", "KGM"] as const).map((unitCode, i) => ({ ...line, id: String(i), unitCode })) };
  cases.greek = { ...invoice, seller: { ...invoice.seller, vatId: "EL123456789", address: { ...invoice.seller.address, countryCode: "GR" } } };
  cases.kosovo = { ...invoice, seller: { ...invoice.seller, vatId: "1A123456789", address: { ...invoice.seller.address, countryCode: "1A" } } };
  cases.zero = { ...invoice, lines: [{ ...line, unitPrice: "0" }] };
  cases.precision = { ...invoice, lines: [{ ...line, quantity: "0.0001", unitPrice: "99999.9999", taxRate: "7.1250" }] };
  cases.large = { ...invoice, lines: [{ ...line, quantity: "1", unitPrice: "8403361344.5294" }] };
  cases.many = { ...invoice, lines: Array.from({ length: 1000 }, (_, i) => ({ ...line, id: String(i), quantity: "1", unitPrice: "8403361.3350" })) };
  cases.characters = { ...invoice, number: 'RE <&> "ä"', notes: ["Agreement & terms\r\n<signed>"], lines: [{ ...line, name: 'Äpfel & Öl <"A">', description: "Line\nTwo" }] };
  cases.rates = { ...invoice, lines: ["7", "19", "19.0000", "0.0001", "100"].map((taxRate, i) => ({ ...line, id: String(i), taxRate, unitPrice: "1.0050", quantity: "3.3333" })) };
  for (const [name, input] of Object.entries(cases)) {
    const file = unwrap(einvoice.serialize(input, { format: "zugferd-2.5-en16931" }));
    unwrap(await validateInvoiceXml(file.xml, { format: file.format }));
    await Bun.write(join(work, "invoices", `${name}.xml`), file.xml);
  }
  const xml = unwrap(einvoice.serialize(invoice, { format: "zugferd-2.5-en16931" })).xml;
  // These mutations remain XSD-valid. Schematron must reject the business-rule violations.
  const invalid = {
    "bad-total": xml.replace("<ram:GrandTotalAmount>140.40", "<ram:GrandTotalAmount>999.00"),
    "bad-tax": xml.replace("<ram:CalculatedAmount>19.00", "<ram:CalculatedAmount>18.00"),
    "bad-country": xml.replace("<ram:CountryID>DE", "<ram:CountryID>ZZ"),
    "bad-vat": xml.replace(invoice.seller.vatId, "ZZ123456789"),
  };
  for (const [name, source] of Object.entries(invalid)) {
    if (source === xml) throw new Error(`Mutation did not apply: ${name}`);
    unwrap(await validateInvoiceXml(source, { format: "zugferd-2.5-en16931" }));
    await Bun.write(join(work, "invoices", `${name}.xml`), source);
  }
  const java = Bun.spawn(["java", "-jar", join(cache, artifacts[0]!.sha256 + "-saxon.jar"), `-s:${join(work, "invoices")}`, `-xsl:${join(cache, artifacts[1]!.sha256 + "-cii.xslt")}`, `-o:${join(work, "reports")}`], { stdout: "inherit", stderr: "inherit" });
  if (await java.exited !== 0) throw new Error("Saxon failed");
  const sepaFile = unwrap(sepa.serialize(sepaExample));
  unwrap(await validateSepaXml(new TextDecoder().decode(sepaFile.bytes)));
  await Bun.write(join(work, "sepa.xml"), sepaFile.bytes);
  await Bun.write(join(work, "datev.csv"), unwrap(datev.serialize(datevExample)).bytes);
  const python = Bun.spawn(["python3", new URL("./finance-conformance.py", import.meta.url).pathname, work], { stdout: "inherit", stderr: "inherit" });
  if (await python.exited !== 0) throw new Error("Independent finance checks failed");
} finally {
  await rm(work, { recursive: true, force: true });
}
