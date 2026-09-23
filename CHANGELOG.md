# Changelog

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
