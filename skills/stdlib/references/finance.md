# Finance serialization

For camt.052 account report reading, see `camt.md`.

Import `{ datev, sepa }` from `@k2b/stdlib/finance`. This subpath requires optional
peers `zod@^4.4.3`, `ibantools@^4.5.4` and `saxes@^6.0.0`. Serialization is synchronous pure JS.
The separate `@k2b/stdlib/finance/validate` subpath exports `validateSepaXml` and
`sepaSchemaSha256`; only this checker requires `libxml2-wasm@0.6.0`.
Never re-export the checker from finance or finance from the root.

- `datev.validate(unknown)` / `sepa.validate(unknown)` return validated batches in
  stdlib `Result`; no coercion or Zod objects cross the runtime boundary.
- `datev.serialize(DatevBatch)` returns `Result<DatevFile>` with `bytes`,
  `rowCount`, `debitTotal`, `creditTotal`.
- `sepa.serialize(SepaBatch)` returns `Result<SepaFile>` with `bytes`,
  `rowCount`, `total`. Input checks run, but no XSD validation is claimed.
- `validateSepaXml(string)` checks arbitrary XML against the pinned XSD only;
  it does not check semantic control sums or application duplicate policy.
- Errors have `BAD_INPUT`/`INTERNAL`, status, message, and `issues`. Issue codes:
  `invalid_input`, `invalid_xml`, `schema_mismatch`, `schema_integrity`,
  `validator_unavailable`; `path` uses zero-based row indices. XML errors use
  `["xml"]` plus one-based `line`/`column` when available.

Required format literals: `datev-700-13` and
`sepa-sct-pain.001.001.09-gbic-5`. Both require `currency: "EUR"` and a caller
`createdAt` UTC string with exactly three fraction digits. SEPA message,
payment-information and end-to-end IDs are caller supplied; end-to-end IDs must
be unique within a file. Output preserves row order and is deterministic.

Amounts must be positive strings with exactly two decimal digits, no leading
zeros, exponents, or rounding. DATEV max `9999999999.99`; SEPA max `999999999.99`.
DATEV uses direction `S`/`H`, including credits. Totals remain exact decimal
strings; do not convert them to floating-point numbers.

DATEV supports consultant/client numbers, fiscal year and posting period,
account length, label, explicit finalize, and postings with accounts, document
date/number, optional text, tax key and cost centers. UTF-8 BOM, 31 header fields,
125 columns, CRLF. Optional `applicationInformation` (up to 16 characters) is
empty by default; use `"Grids"` to preserve the extracted renderer's bytes.

SEPA supports ordinary EUR SCT, one debtor/execution date/payment block, multiple
transfers, unstructured remittance, optional BICs; no instant payments, addresses
or direct debits. Names/remittance are escaped without transliteration. IBANs
must be canonical uppercase, valid SEPA IBANs, not QR-IBANs.

The pinned schema hash is
`35cfe972a636392704fd930c3e0496fc05b95ff891deb635b168dcdabf3c08a3`.
No filesystem or external schema/entity resolution. Bun, Chromium and browser
workers are verified. Only optional-validator Bun browser bundling needs `external: ["module"]` for the
validator's conditional Node branch; use `splitting: true` to retain lazy chunks.
Web Crypto and WebAssembly are required for schema validation.

Applications retain mapping, authorization, confirmation, storage, audit,
business identities, durable duplicate claims, size limits, and payment status.
A generated file is neither bank submission nor payment or guaranteed acceptance.
No bank data, account codes or tax keys are inferred.

Repository references: `docs/finance.md`, `examples/finance.ts`, and
`docs/finance-grids-integration.md`. The latter is a proposal; Cloud was not
modified by this extraction.

For CII E-Invoice XML generation and XML/PDF reading, see `einvoice.md`.
