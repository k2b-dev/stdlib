# DATEV XML schemas

`datev-xml-schema.ts` embeds four XSD files of the DATEV XML-Schnittstelle
online, version 6.0, byte-for-byte (UTF-8, CRLF):

| File | SHA-256 |
|---|---|
| `Document_v060.xsd` | `11759fba36a156719e7cc3c1e19708aa0ea885e9093b6bdbb6a495c40bff362a` |
| `Document_types_v060.xsd` | `78ee3cb0f05aa93652347cd5693184b16ab52985b83e1270234448db68327022` |
| `Belegverwaltung_online_ledger_import_v060.xsd` | `b2807c9ef14c87dea214bda5c3b2cf2de8333511897eb51dbf19b526409f62be` |
| `Belegverwaltung_online_ledger_types_v060.xsd` | `a2bc696b0dbf18b49943001a06e6268f0480aaaa8bf272964972b524ec2542a3` |

- Source: DATEV Developer Portal, "DATEV XML interface online", section
  "XSD-Files": <https://developer.datev.de/assets/XSD_3c866dbe96.zip>
  (archive SHA-256 `0b25a3e512a262c93142d977b88bc04d1169e1495ebf72069cb074d6c4c42cb0`),
  retrieved 2026-10-18. The archive also contains the invoice-format XSDs, which
  are not used here.
- Regenerate with `bun scripts/datev-xml-schema.ts <unpacked directory>` and pin
  the printed hash as `datevXmlSchemaSha256` in `validate.ts`.
- The fixtures in `examples/fixtures/datev-xml/datev-samples/` are unchanged XML
  files from DATEV's sample archives on the same portal page (section "Sample
  files"), retrieved 2026-10-18.

The schemas and samples are © DATEV eG. DATEV publishes them without login for
developers and recommends implementing XSD validation with them in one's own
software ("We also recommend that developers implement an XSD validation based
on our XSD files in their software themselves"). No explicit license text was
found on the portal or in the files. They are redistributed unchanged for that
purpose only; the stdlib implementation remains ISC. Remove them on request of
DATEV.
