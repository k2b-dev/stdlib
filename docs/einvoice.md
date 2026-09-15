# Generate and read E-Invoice XML

Use `einvoice` from `@k2b/stdlib/finance` for the supported CII EN16931 slice.
It generates XML and reads XML or an embedded PDF attachment. It does not render
PDFs or import records into an accounting system.

## Supported invoices

The generation format is `zugferd-2.5-en16931`, pinned to the ZUGFeRD 2.5 /
Factur-X 1.09 EN16931 XSD distribution. The XML uses CII namespaces and guideline
`urn:cen.eu:en16931:2017`. This guideline does not identify the precise standard
release of an incoming document: the returned `format` identifies the stdlib
reader contract, not proof that a sender used version 2.5.

The slice supports EUR invoices, positive credit notes referring to an earlier
invoice, and self-billing. It requires seller and buyer names, addresses, and VAT
identifiers, buyer reference, service date, due date and a SEPA credit-transfer
account. Seller always means supplier, including in self-billing. Notes are
preserved as text; the reader does not infer agreement references from prose.

Positions support names, optional descriptions, positive quantities, unit prices of zero or more, standard VAT category `S`, rates greater than 0 and at most 100,
and units `C62`, `HUR`, `DAY`, `KGM`. Rates are not checked against a country's
current tax rules. The caller determines which rates apply.

Other profiles, UBL/XRechnung, exemptions, discounts, surcharges, prepayments,
price base quantities and additional XML fields are rejected. This is an
intentional subset: the reader must not silently discard invoice semantics.

## Generate XML

Pass an `Invoice` with explicit line IDs and string amounts. Start from the
[runnable example](../examples/einvoice.ts), which includes both parties and
payment details.

```ts
import { einvoice } from "@k2b/stdlib/finance";

const checked = einvoice.validate(input); // unknown -> Result<Invoice>
if (!checked.ok) throw new Error(checked.error.message);

const generated = einvoice.serialize(checked.data, {
  format: "zugferd-2.5-en16931",
});
if (!generated.ok) throw new Error(generated.error.message);

// generated.data.xml: XML string
// generated.data.bytes: the same XML encoded as UTF-8
```

`validate` checks the model's shape and supported values. `serialize` also
calculates amounts and checks any declared line amounts and totals. All return
the usual stdlib `Result`, with structured `error.issues` on failure.

`einvoice.calculate(lines)` returns rounded lines, tax groups, net amount, tax,
gross amount and due amount. Each line is rounded half up to cents. VAT is then
rounded half up per numerically distinct rate. For example, `19` and `19.00`
belong to one group. No calculation converts amounts to JavaScript numbers.

Quantities, unit prices and rates accept up to four decimal places and at most
200 characters. Prices retain those decimal places in XML: `1.0050` stays
`1.0050`, even when the line amount rounds to `1.01`. Totals use exactly two
decimal places. Limits include 1,000 lines and 100 notes. Text fields reject
invalid XML characters; unknown input fields are rejected.

## Read XML or PDF

```ts
const parsedXml = einvoice.parseXml(xml);
const parsedPdf = await einvoice.parsePdf(pdfBytes);
```

Successful results contain `invoice`, the unchanged `xml`, `profile`, and
`format`. PDF results also contain `filename`. Parsed invoices include the
**declared** line amounts and totals. Reading does not recalculate or silently
correct them. To check their agreement with this slice's rounding policy, pass
the parsed invoice to `serialize`; inconsistent declared values return errors.

The XML reader checks namespaces, required fields, cardinality, and supported
values. Prefix names do not matter. Comments and CDATA are accepted. DTDs,
unknown entities and unrepresented fields or attributes are rejected. Parsing
is not an XSD or Schematron validation result.

PDF reading requires optional peer `pdf-lib@1.17.1`, loaded when `parsePdf` is
called. It searches document-level name trees and associated files for exactly
one attachment named `factur-x.xml`, `zugferd-invoice.xml` or `xrechnung.xml`
(case insensitive). A recognized filename does not imply a supported profile.
Ambiguous attachments, encrypted PDFs and invalid UTF-8 XML are rejected.
There is no OCR, PDF/A validation or comparison of visual content with XML.

Optional parser limits are `maxCharacters` (10 Mi characters), `maxElements`
(100,000), and `maxDepth` (64). PDF options also include `maxPdfBytes` (25 MiB).
These are input and XML-tree budgets, not a hard memory or CPU sandbox for
PDF parsing. Applications accepting hostile PDFs can isolate the operation in
a worker or separate process with their own resource budget.

## Validate the XML schema

```ts
import { validateInvoiceXml } from "@k2b/stdlib/finance/validate";

const schemaResult = await validateInvoiceXml(xml, {
  format: "zugferd-2.5-en16931",
});
```

This separately loaded checker uses the pinned profile XSDs and optional
`libxml2-wasm@0.6.0`, with Web Crypto for schema integrity. It rejects DTDs before
WASM parsing and serves schema imports from a fixed in-memory map. It requires
no filesystem access or network schema fetches. Browser bundling of the WASM
peer uses `external: ["module"]` with Bun, as for the existing finance validators.

The result covers **XSD only**. It does not execute Schematron, check invoice
arithmetic, certify PDF/A, or establish legal/tax compliance. Use the model and
generation checks for this slice's arithmetic; keep any broader business-rule
validator and its version visible in application evidence.

See [schema provenance and licensing](../src/finance/einvoice-schema-NOTICE.md).
