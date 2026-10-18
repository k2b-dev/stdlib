# DATEV XML-Schnittstelle online (Belegtransfer)

Requires `@k2b/stdlib >= 0.30.0`. Full contract: `docs/datev-xml.md`.

- `datevXml.validate(unknown)` and `datevXml.serialize(DatevXmlPackage)` from
  `@k2b/stdlib/finance`: synchronous, pure JS, no XSD engine. `serialize` returns
  `DatevXmlFile` with `bytes` (ZIP), `documentXml`, `lineCount`, and per document
  `dataFile`, `xml`, `amount` (exact signed sum) and `files`.
- `createDatevXmlPackage(input)` from `@k2b/stdlib/finance/validate`: serialize
  plus XSD check of document.xml and every ledger file; returns bytes only when
  all pass. Use it for files given to DATEV. Needs `libxml2-wasm@0.6.0`.
- `validateDatevXml(xml, { schema: "document" | "ledger" })` checks one file.
- Package: `format: "datev-xml-online-6.0"`, `currency: "EUR"`, `createdAt` as
  local `YYYY-MM-DDTHH:mm:ss` (no offset), `generatorInfo` (sender name, 1–40),
  optional `generatingSystem`, `description`, `documents` (1–4999).
- Document `kind`: `accountsPayableLedger` / `accountsReceivableLedger`
  (`period`, `folder`, `documentDate`, `documentNumber`, `lines`, `files`, party
  and date fields) or `cashLedger` (`period`, `cashRegister: { accountNumber } |
  { name }`, `documentDate`, `lines` with required `text`, `files`).
- Amounts: `"-12.30"` strings, never `0.00`. Invoice lines share one sign
  (negative = correction); cash lines may mix (negative = expense).
- Text: DATEV repertoire only (ASCII, Latin-1 letters, `€`, CJK, Hangul), NFC, no
  edge spaces; `text` max 30. Nothing is cut or replaced; failures carry paths.
- File names: ASCII, unique case-insensitively, DATEV file types, max 100
  characters; bytes 1 B–20 MB, signatures checked for PDF and images.
- A passing check does not prove the client's DATEV settings (fiscal year,
  folder and cash register names, accounts, BU keys); test-import once.
