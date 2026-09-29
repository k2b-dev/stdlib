# Changelog

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
