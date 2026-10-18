# Changelog

## 0.30.0 — 2026-10-18

- Add DATEV XML-Schnittstelle online 6.0 packages for DATEV Belegtransfer:
  `datevXml.validate` and `datevXml.serialize` in `@k2b/stdlib/finance` build a
  ZIP with `document.xml`, one ledger file per document and the document images
  for incoming invoices (`accountsPayableLedger`), outgoing invoices
  (`accountsReceivableLedger`) and cash (`cashLedger`, Kassenbuch online).
  Serialization is synchronous, deterministic and needs no XSD engine.
- Add `createDatevXmlPackage` and `validateDatevXml` in
  `@k2b/stdlib/finance/validate`. `createDatevXmlPackage` checks `document.xml`
  and every ledger file against the pinned DATEV XSDs (version 6.0) and returns
  bytes only when all pass; `datevXmlSchemaSha256` pins the embedded schemas.
- Invalid values fail with field paths and are never cut, replaced or converted:
  DATEV character set and NFC, field lengths (booking text 30), `0.00` amounts,
  mixed signs within an invoice, creditor and debtor account ranges, dates
  outside the period, duplicate GUIDs, file names, types and sizes (20 MB per
  file), and DATEV's package limits (4999 documents, 5000 lines, 465 MB).

## 0.29.0 — 2026-10-12

- Add German public holidays by federal state: `publicHolidays(year, region)`
  returns the statutory holidays of `"DE"` or `"DE-<state>"` as dates with stable
  keys (no translated names), including Easter-based dates and the years in which
  state holidays were introduced. Out-of-range years throw a `RangeError` (#8).
- Declare `"sideEffects": false`, so bundlers keep only the root exports you
  import. Importing `i18n` alone no longer pulls in dayjs and big.js (about 41 KB
  minified down to about 1.5 KB). If you use dayjs directly, register its `utc`
  and `timezone` plugins yourself (#9).

## 0.28.0 — 2026-10-08

- Keep errors thrown by components and computations that read Solid primitive
  signals out of the primitive's own state. `query.create`, `query.createInfinite`,
  `mutation.create`, `clipboard.create`, and `clipboard.createWriter` no longer
  store these errors in `error()`; they reach the nearest Solid error boundary or
  surface as unhandled errors.
- Commit query results in one batch after internal state settles. Loading flags
  stay consistent and `invalidate()` resolves when its snapshot was committed,
  even if a reader throws. A reader error while a load, `invalidate()`,
  `loadMore()`, or `abort()` starts no longer leaves a query looking busy without
  a running load.
- **Behavior change:** `mutate()` and `retry()` reject with errors thrown by
  `onSuccess` or by readers of the committed result. These errors no longer set
  `error()` or call `onError`. `onSuccess` runs after `data()` and `loading()`
  are updated. Handle `onSuccess` failures with `try/catch` around `mutate()` or
  an error boundary instead of `onError`.
- Clipboard `copy()` rejects with reader errors during copy feedback instead of
  reporting a failed copy, and `wasCopied()` always resets.

## 0.27.0 — 2026-09-29

- Make E-Invoice payment instructions optional. Support cash (10), credit
  transfer (30/58), online payment services (68), and clearing (97), with optional
  payment information. Existing payment objects default to 58 with unchanged XML.
- Add header invoicing periods and allow invoice/selfBilling references for
  additional charges. Add `selfBillingCreditNote` (261) for buyer-issued reductions;
  update exhaustive kind switches. Credit notes can omit payment instructions. Validate
  payment accounts, period dates, reference numbers/dates and K delivery data.
- **Type migration:** `Invoice.payment` and `serviceDate` are optional, including
  default XML/PDF parse results. Guard presence before access. Bank fields are
  optional in the type and checked by payment code; readers return explicit codes.
- **Output change:** Absolute dates use Intl locale order and punctuation for
  every locale. Default English becomes `Mar 5, 2025`; German becomes
  `5. März 2025`. This also affects `formatDateTime`, relative absolute fallbacks
  and recurrence until dates. UTC defaults and the 24-hour clock are unchanged.
- Add `formatDate(input, { style: "numeric" })` for padded numeric dates in locale
  order. `formatDateKey`, `formatDateShort`, and relative bucket logic stay unchanged.
- Add payment, period, and correction round trips, legacy XML byte regression,
  XSD checks, official CII Schematron cases, and migration examples.

## 0.26.0 — 2026-09-23

- Generate and read CII EN16931 invoices with VAT categories S, Z, E, AE, K, G,
  and O. Omitted categories still mean S; existing S XML output is unchanged.
- Group tax by category and numeric rate. Accept exemption text (BT-120) and
  VATEX codes (BT-121) on lines or declared groups, and return group reasons on
  parsed lines. Support mixed S+E invoices and E margin schemes with VATEX-EU-F,
  VATEX-EU-I, and VATEX-EU-J.
- Check category rates, zero disclosed tax, reasons, identities, group
  membership, and O exclusivity. Z forbids exemption reasons. O omits XML rates
  and VAT IDs while retaining `taxRate: "0"` and `vatId: ""` in the string API.
- Add optional party `id`, seller `taxRegistrationId`, and invoice
  `deliverToCountryCode` for the relevant identity and delivery requirements.
  AE/K require the buyer VAT ID; K also requires the actual delivery country.
- Add an example for §25a, category round trips, XSD checks, and official EN16931 CII
  Schematron regression cases. Runtime XML validation remains XSD-only.
- Add backward-compatible `mode: "incoming"` XML/PDF overloads with a separate
  `IncomingInvoice` model for independent EN16931 and CII XRechnung 3.0/2.3
  invoices. Preserve optional data, payment variants, currencies, price bases,
  periods, adjustments, declared totals, and explicitly unmapped XML fields.
- Run 11 unchanged, hash-pinned public invoices through extraction assertions,
  XSD and official EN16931 core Schematron in CI. Add malformed-input and
  ambiguity regressions; existing strict reader/generation APIs stay intact.
- Keep the compiled invoice XSD available after another libxml2 consumer resets
  global input providers; repeated and concurrent validation stays independent.
