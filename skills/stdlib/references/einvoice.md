# E-Invoice slice

Import `{ einvoice }` and `Invoice` from `@k2b/stdlib/finance`.
Read `docs/einvoice.md` in the repository for limits and the complete contract.

- `validate(unknown)` checks supported values, calculated output limits, and all
  supplied amounts/tax groups, using the same rules as serialization. It neither
  fills totals nor changes original values. Use it after parsing to check arithmetic.
- `calculate(lines)` returns exact decimal totals, lines, and tax groups.
- `serialize(invoice, { format: "zugferd-2.5-en16931" })` generates UTF-8 XML and
  checks any supplied line amounts and totals against the calculated values.
- `parseXml(xml, options?)` and async `parsePdf(bytes, options?)` preserve incoming
  declared amounts. Parsing does not certify their arithmetic.
- `validateInvoiceXml(xml, { format: "zugferd-2.5-en16931", ...limits })` is exported
  only from `@k2b/stdlib/finance/validate`; it checks pinned XSDs, not Schematron.

The slice covers EUR CII EN16931 invoices, credit notes with an original invoice
reference, and self-billing, with category S VAT and C62/HUR/DAY/KGM units.
The reader rejects unsupported XML fields. No UBL, XRechnung, discounts, prepayments,
exemptions, OCR, PDF rendering or PDF/A certification. Profile URNs cannot
establish the exact release of an incoming document.

Keep amounts as strings. Round each line half up to cents, then VAT per rate.
Preserve unit-price precision (up to four decimal places). Never convert through
Number or copy Cloud's former Factur-X numeric mapping.

PDF reading loads optional `pdf-lib@1.17.1`. XSD validation loads optional
`libxml2-wasm@0.6.0`. Pure XML operations do not execute either runtime.
Cloud owns snapshot mapping, numbering, HTML/Gotenberg, permission checks,
issuance, embedding verification and artifact persistence.

Input country codes and VAT prefixes use the pinned EN16931 code lists; national
VAT identity checks remain caller-owned. The generated gross total is capped at
`9999999999.99` EUR to stay within the independently tested output range.
`calculate` retains its larger exact-decimal range. Tax-group errors identify
indices and fields; missing groups use `totals.taxGroups`.

The repository's `bun run test:finance-conformance` executes official CII
Schematron using pinned Saxon-HE, independent decimal checks, and XSDs. This does
not add runtime Schematron to `validateInvoiceXml`. Keep Cloud's runtime XSD and
actual embedded-XML checks during migration; CI cannot verify Gotenberg output.
