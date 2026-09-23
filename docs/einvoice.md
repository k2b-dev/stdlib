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
invoice, and self-billing. It requires seller and buyer names and addresses,
buyer reference, service date, due date and a SEPA credit-transfer
account. Seller always means supplier, including in self-billing. Notes are
preserved as text; the reader does not infer agreement references from prose.

Positions support names, optional descriptions, positive quantities, unit prices
of zero or more, and units `C62`, `HUR`, `DAY`, `KGM`. From version 0.26.0, VAT
categories are `S`, `Z`, `E`, `AE`, `K`, `G`, and `O`; omitted `taxCategory` means
`S`. Existing S inputs and their generated XML remain unchanged. The caller
determines the applicable category and rate.

These are the generation and default reader limits. For broader incoming CII
documents, use the additive `mode: "incoming"` reader described below. It also
accepts CII XRechnung 3.0 and 2.3, payment variants, price base quantities,
adjustments and declared prepayments. UBL and generation of those additional
features remain outside this module.

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

`validate` and `serialize` share the same input, calculation, and consistency
checks. Both reject contradictory supplied line amounts, totals, and tax groups.
`validate` preserves the input values and does not fill optional totals. All return
the usual stdlib `Result`, with structured `error.issues` on failure.

`einvoice.calculate(lines)` returns rounded lines, tax groups, net amount, tax,
gross amount and due amount. Each line is rounded half up to cents. VAT is then
rounded half up per category and numerically distinct rate. For example, S at
`19` and S at `19.00` belong to one group; E at `0` and Z at `0` are separate. No calculation converts amounts to JavaScript numbers.

Quantities, unit prices and rates accept up to four decimal places and at most
200 characters. Prices retain those decimal places in XML: `1.0050` stays
`1.0050`, even when the line amount rounds to `1.01`. Totals use exactly two
decimal places. Generation and `validate` limit the calculated gross total to
`9999999999.99` EUR. This is a tested library boundary, not an EN16931 legal
maximum: the official Schematron has floating-point sum checks that can fail at
extreme scales. `calculate` retains its larger exact-decimal range. Limits include 1,000 lines and 100 notes. Text fields reject
invalid XML characters; unknown input fields are rejected.

## VAT categories and exemption reasons

`InvoiceLine` and `InvoiceTotals.taxGroups` accept optional `taxCategory`,
`taxExemptionReason` (BT-120), and `taxExemptionReasonCode` (BT-121). Reasons belong
to the tax group in XML. Supply them on lines for automatic calculation, or on
explicit `totals.taxGroups`. The reader returns them on both groups and their
matching lines. Reasons supplied in several places must agree; differing reasons
never create additional groups for the same category and rate.

| Category | Meaning | API rate | Group reason |
|---|---|---|---|
| `S` (default) | Standard VAT | Greater than 0, at most 100 | Forbidden |
| `Z` | Zero rated | `"0"` | Forbidden (BR-Z-10) |
| `E` | Exempt, including margin-scheme representation | `"0"` | Text and/or matching VATEX code |
| `AE` | Reverse charge | `"0"` | Text and/or `VATEX-EU-AE` |
| `K` | Intra-community supply | `"0"` | Text and/or `VATEX-EU-IC` |
| `G` | Export outside the EU | `"0"` | Text and/or `VATEX-EU-G` |
| `O` | Outside the scope of VAT | `"0"`; XML omits the rate | Text and/or `VATEX-EU-O` |

All non-S groups have zero disclosed tax. Text must describe the applicable
reason; the library checks presence, not the legal meaning of arbitrary prose.
Codes are checked against the VATEX list in EN16931 validation 1.3.16 and must
match their category. The API preserves their spelling. Local tax eligibility
and the interpretation of exemption text remain with the caller.

Mixed S+E invoices are supported. O must be the only category in its invoice.
Each non-S category has exactly one group. Equivalent decimal zero rates are
accepted; reading O normalizes the absent XML rate to `"0"`.

`vatId` remains a required string to preserve existing TypeScript consumers.
Use `""` when no VAT identifier is present; XML omits that registration and the
reader returns `""` when it is absent. O requires empty seller and buyer VAT IDs.
Other categories require a seller VAT ID, or `seller.taxRegistrationId` (BT-32)
for S/Z/E/AE. K/G require the seller VAT ID. A seller without a VAT ID also needs
`seller.id` (BT-29, BR-CO-26). Optional `buyer.id` represents BT-46.
AE/K require a buyer VAT ID in this slice; other categories allow an empty buyer
VAT ID. Alternative legal-registration or tax-representative identities are not
supported. Buyer tax registration is not supported.

K also requires `deliverToCountryCode` (BT-80); set the actual destination rather
than assuming the buyer's address is the destination. The required `serviceDate`
already supplies the delivery date (BT-72).

`calculate(lines)` checks categories, rates, and conflicting supplied reasons,
but does not require a reason or party data: these may be supplied when the
invoice is assembled. `validate` and `serialize` require complete groups and
identities, and verify supplied amounts. Parsing checks category constraints and
group membership, while preserving declared arithmetic for subsequent validation.

### Differenzbesteuerung under § 25a UStG

Use category E with zero disclosed VAT and the applicable margin-scheme code:

| Goods | VATEX code | German invoice wording |
|---|---|---|
| Second-hand goods | `VATEX-EU-F` | Gebrauchtgegenstände/Sonderregelung |
| Works of art | `VATEX-EU-I` | Kunstgegenstände/Sonderregelung |
| Collectors' items and antiques | `VATEX-EU-J` | Sammlungsstücke und Antiquitäten/Sonderregelung |

The [VATEX list](https://docs.peppol.eu/poacc/billing/3.0/codelist/vatex/)
assigns these codes to E. The wording comes from
[§ 14a(6) UStG](https://www.gesetze-im-internet.de/ustg_1980/__14a.html).
The European Commission maintains the
[official code-list registry](https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467108974/Registry+of+supporting+artefacts+to+implement+EN16931).

Starting with the complete invoice in the [base example](../examples/einvoice.ts):

```ts
import { einvoice, type Invoice } from "@k2b/stdlib/finance";

const marginInvoice: Invoice = {
  ...invoice,
  lines: [{
    id: "1", name: "Antiker Schrank", quantity: "1", unitPrice: "1200.00",
    unitCode: "C62", taxCategory: "E", taxRate: "0",
    taxExemptionReason: "Sammlungsstücke und Antiquitäten/Sonderregelung (§ 25a UStG)",
    taxExemptionReasonCode: "VATEX-EU-J",
  }],
};
const result = einvoice.serialize(marginInvoice, {
  format: "zugferd-2.5-en16931",
});
```

The [runnable margin example](../examples/einvoice-margin.ts) produces a total of
EUR 1,200.00 and disclosed tax of EUR 0.00. `unitPrice` is the full selling price,
including any VAT contained in the margin. E is the invoice representation; it
does not mean the dealer owes no margin VAT. This module neither calculates the
internal margin nor reports it separately on the invoice.

If several exempt lines need different explanations, supply one combined text
on their shared E group (or the same combined text on each line) and omit a code
that would describe only some of them. Keep item-specific details in descriptions.
Conflicting F/I/J codes on separate E lines are rejected rather than silently
choosing one code or emitting multiple E groups (BR-E-01).

## Read XML or PDF

For independent invoices, select the incoming model explicitly:

```ts
const parsed = einvoice.parseXml(xml, { mode: "incoming" });
const embedded = await einvoice.parsePdf(pdfBytes, { mode: "incoming" });
if (!parsed.ok) throw new Error(parsed.error.message);

const { invoice, unmapped } = parsed.data;
// invoice.payments: all payment means, possibly empty
// invoice.serviceDate / paymentTerms / buyerReference: optional
// invoice.lines[].priceBasis: optional quantity and optional unit
// invoice.adjustments and lines[].adjustments: declared allowances/charges
// invoice.totals: declared totals, including optional prepaid/rounding amounts
// unmapped: supplementary elements/attributes with namespace-aware XML paths
```

The incoming overload returns `ParsedIncomingInvoice` with `format: "cii-en16931"`,
`invoice`, unchanged original `xml`, `profile`, and `unmapped`. PDF results also
contain `filename`. It recognizes the EN16931 guideline and these exact CII CIUS
identifiers:

- `urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0`
- `urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3`

This identifies supported extraction, not national CIUS conformance. The
[independent original-invoice regression](./einvoice-external-examples.md) checks
11 unchanged public invoices, their extracted values, XSD and EN16931 core rules.

`IncomingInvoice` preserves signed, arbitrarily precise decimal strings, other
invoice currencies, optional VAT accounting currency, multiple payment means,
periods, price bases, gross prices, adjustments, references and party identifiers.
Absent values remain `undefined`; optional empty text remains `""`. O line rates
remain absent, while a declared zero O group rate is preserved. Exemption reasons
are projected from groups to matching lines. No arithmetic is recalculated and
no missing dates, rates, identifiers or payments are invented.

The reader checks required core fields, singleton cardinalities, decimal/date
syntax, VAT categories, group membership, reasons, and relevant identities.
AE accepts a buyer legal registration ID as an alternative to the VAT ID; K
requires a buyer VAT ID, delivery country, and delivery date or invoice period.
Seller tax representative identities are supported. Contradictory line/group
reasons fail. These checks do not replace the complete EN16931 Schematron.

Unmapped supplementary fields, including attachments and product metadata, are
returned explicitly with their namespace, path, attributes and subtree. They
are not executed or decoded. Review them before using the projection for
accounting. The original `xml` is the complete source of truth; the supplementary
element tree is for inspection and does not preserve mixed-content ordering,
comments or lexical XML formatting. The incoming model is not an `Invoice` and
cannot be passed directly to the serializer without a deliberate mapping into
its narrower generation contract.

Existing calls without a mode retain the strict, backward-compatible contract:

```ts
const parsedXml = einvoice.parseXml(xml); // Result<ParsedInvoice>
const parsedPdf = await einvoice.parsePdf(pdfBytes);
```

They return the generation model and reject unsupported fields. Their declared
amounts can be checked with `einvoice.validate`, which applies the generation
slice's arithmetic. Both readers reject malformed XML, DTDs, unknown entities,
ambiguous mapped fields and invalid namespace substitutions. Prefixes, comments
and CDATA are accepted. Neither reader runs XSD or Schematron automatically.

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
  mode: "incoming", // also permit the two supported CII XRechnung identifiers
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

## Input checks and independent conformance

Country codes and VAT country prefixes are checked against the code lists used
by EN16931 validation 1.3.16 (including the Greek `EL` VAT prefix). Dates exclude
year zero. VAT registration existence, national checksum rules, applicable tax
rates, self-billing agreements, and the original invoice's business identity
remain application responsibilities.

The repository runs pinned official EN16931 CII Schematron with Saxon-HE in CI,
alongside the profile XSD and independent Python decimal checks. Cases include
all three document kinds, all seven VAT categories, F/I/J margin schemes, mixed
S+E and zero-rate categories, equivalent rates, four-decimal prices, rounding,
zero prices, special characters, the output amount boundary, and 1,000 lines.
XSD-valid mutations with wrong sums, tax, country codes, and VAT prefixes must
fail the expected Schematron rules. This is regression evidence for the
supported slice, not a universal compliance certificate.

See [finance conformance and migration](./finance-conformance.md) for pinned
sources, the local command, changed input behavior, and runtime-check policy.
