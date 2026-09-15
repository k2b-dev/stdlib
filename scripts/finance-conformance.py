"""Independent XML/CSV/decimal checks; uses only Python's standard library."""
import csv
import io
import sys
import xml.etree.ElementTree as ET
from decimal import Decimal, ROUND_HALF_UP
from hashlib import sha256
from pathlib import Path

work = Path(sys.argv[1])
expected_failures = {
    "bad-total": "BR-CO-15", "bad-tax": "BR-S-09",
    "bad-country": "BR-CL-14", "bad-vat": "BR-CO-09",
}
reports = list((work / "reports").glob("*.xml"))
assert len(reports) == len(list((work / "invoices").glob("*.xml"))), "Missing SVRL reports"
for path in reports:
    report = ET.parse(path)
    assert report.getroot().tag == "{http://purl.oclc.org/dsdl/svrl}schematron-output"
    failures = [node.attrib["id"] for node in report.findall(".//{*}failed-assert")]
    if path.stem in expected_failures:
        assert expected_failures[path.stem] in failures, (path.name, failures)
    else:
        assert not failures, (path.name, failures)

# Independent exact arithmetic over the emitted CII, without stdlib's reader/calculator.
for path in (work / "invoices").glob("*.xml"):
    if path.stem in expected_failures:
        continue
    invoice = ET.parse(path)
    groups = {}
    for line in invoice.findall(".//{*}IncludedSupplyChainTradeLineItem"):
        quantity = Decimal(line.findtext(".//{*}BilledQuantity"))
        price = Decimal(line.findtext(".//{*}ChargeAmount"))
        amount = (quantity * price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        assert Decimal(line.findtext(".//{*}LineTotalAmount")) == amount
        rate = Decimal(line.findtext(".//{*}RateApplicablePercent"))
        groups[rate] = groups.get(rate, Decimal(0)) + amount
    settlement = invoice.find(".//{*}ApplicableHeaderTradeSettlement")
    taxes = settlement.findall("{*}ApplicableTradeTax")
    assert len(taxes) == len(groups)
    tax_total = Decimal(0)
    for tax in taxes:
        rate = Decimal(tax.findtext("{*}RateApplicablePercent"))
        basis = groups[rate]
        amount = (basis * rate / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        assert Decimal(tax.findtext("{*}BasisAmount")) == basis
        assert Decimal(tax.findtext("{*}CalculatedAmount")) == amount
        tax_total += amount
    totals = settlement.find("{*}SpecifiedTradeSettlementHeaderMonetarySummation")
    net = sum(groups.values())
    for tag, expected in [("LineTotalAmount", net), ("TaxBasisTotalAmount", net), ("TaxTotalAmount", tax_total), ("GrandTotalAmount", net + tax_total), ("DuePayableAmount", net + tax_total)]:
        assert Decimal(totals.findtext("{*}" + tag)) == expected

# DK SCT subset: count/sum consistency, payment profile and placement, independently parsed.
def check_sepa(root):
    ns = {"s": "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09"}
    assert root.tag == "{" + ns["s"] + "}Document"
    message = root.find("s:CstmrCdtTrfInitn", ns)
    header = message.find("s:GrpHdr", ns)
    blocks = message.findall("s:PmtInf", ns)
    assert len(blocks) == 1
    block = blocks[0]
    rows = block.findall("s:CdtTrfTxInf", ns)
    assert len(rows) == 2
    amounts = [row.find("s:Amt/s:InstdAmt", ns) for row in rows]
    assert all(node.attrib == {"Ccy": "EUR"} for node in amounts)
    assert sum(Decimal(node.text) for node in amounts) == Decimal("12.31")
    for section in [header, block]:
        assert int(section.findtext("s:NbOfTxs", namespaces=ns)) == len(rows)
        assert Decimal(section.findtext("s:CtrlSum", namespaces=ns)) == Decimal("12.31")
    for path, value in [("s:PmtMtd", "TRF"), ("s:BtchBookg", "true"), ("s:PmtTpInf/s:SvcLvl/s:Cd", "SEPA"), ("s:ChrgBr", "SLEV"), ("s:ReqdExctnDt/s:Dt", "2026-09-14")]:
        assert block.findtext(path, namespaces=ns) == value
    assert rows[0].findtext("s:Cdtr/s:Nm", namespaces=ns) == "Recipient (Example)"
    assert rows[0].findtext("s:RmtInf/s:Ustrd", namespaces=ns) == "Example 'train' & meal"

sepa_xml = (work / "sepa.xml").read_text()
check_sepa(ET.fromstring(sepa_xml))
for damaged in [sepa_xml.replace("<CtrlSum>12.31", "<CtrlSum>12.30"), sepa_xml.replace("<NbOfTxs>2", "<NbOfTxs>3"), sepa_xml.replace("<ChrgBr>SLEV", "<ChrgBr>SHAR")]:
    assert damaged != sepa_xml
    try:
        check_sepa(ET.fromstring(damaged))
    except AssertionError:
        pass
    else:
        raise AssertionError("Independent SEPA checker accepted damaged output")

# CSV parsing is independent of the TypeScript writer. Compare reviewed golden bytes as well.
raw = (work / "datev.csv").read_bytes()
assert raw.startswith(b"\xef\xbb\xbf") and raw.endswith(b"\r\n")
assert b"\n" not in raw.replace(b"\r\n", b"")
records = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"), newline=""), delimiter=";", strict=True))
header, columns, *rows = records
assert len(header) == 31 and len(columns) == 125
# Exact headings from the official DATEV 700/13 sample, retrieved 2026-09-15.
assert sha256(";".join(columns).encode()).hexdigest() == "098f89c80237a74bfa03dd3e1f4bb5cf2ecc8157fb4ee373626bdd70a0966cf7"
assert header[:5] == ["EXTF", "700", "21", "Buchungsstapel", "13"]
assert header[10:16] == ["29098", "55003", "20260101", "4", "20260901", "20260930"]
assert header[18:22] == ["1", "0", "0", "EUR"]
assert len(rows) == 2 and all(len(row) == 125 for row in rows)
assert rows[0][0:3] == ["123,45", "S", "EUR"]
assert rows[0][6:11] == ["00440", "70000", "0009", "1109", "RE-2026-1"]
assert rows[0][13] == 'Office; "rent"'
assert rows[1][0:3] == ["3,00", "H", "EUR"]
assert all(row[113] == "0" for row in rows)
golden = Path(__file__).parent.parent / "examples/fixtures/datev/booking-batch.csv"
assert raw == golden.read_bytes(), "DATEV golden bytes changed; review against the format specification"
print(f"Finance conformance: {len(reports)} Schematron cases, SEPA profile and DATEV golden passed")
