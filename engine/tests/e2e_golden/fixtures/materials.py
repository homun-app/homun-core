"""Due file di prova piccoli — un «.md» e un «.pdf» — generati dal test.

I fatti dentro i file sono unici e NON compaiono mai nei prompt delle richieste:
se la risposta li cita, li ha letti davvero dai materiali.
"""
from __future__ import annotations

# Marcatori presenti SOLO nel file markdown.
MD_NAME = "appunti-riunione.md"
MD_MARKERS = ["14 novembre", "Marco Bianchi", "2 dicembre", "Anna Neri"]

# Marcatori presenti SOLO nel pdf.
PDF_NAME = "piano-audit.pdf"
PDF_MARKERS = ["15 gennaio", "Luca Rossi", "20 dicembre"]

MD_TEXT = """# Appunti riunione — contract forest

- Consegna offerta: 14 novembre 2026 (responsabile Marco Bianchi)
- Pagamento acconto: 2 dicembre 2026 (amministrazione, Anna Neri)
- Il fornitore richiede conferma scritta almeno 10 giorni prima della consegna.
- Punti aperti: verifica assicurazione trasporto, rinnovo polizza qualità.
"""

PDF_LINES = [
    "Piano audit 2026",
    "Audit trimestrale: 15 gennaio 2027 - referente Luca Rossi.",
    "Formazione squadra: 20 dicembre 2026 - aula B, durata mezza giornata.",
    "Chiusura consuntivo: entro il 31 gennaio 2027.",
]


def make_pdf(lines: list[str] | None = None) -> bytes:
    """PDF minimo a una pagina con testo estraibile (Helvetica, nessuna dipendenza).

    L'estrattore del motore usa pypdf: le righe «(…) Tj» con font Type1
    standard vengono lette correttamente, come verificato sul percorso d'oro.
    """
    content = ["BT", "/F1 11 Tf", "72 720 Td"]
    for index, line in enumerate(lines or PDF_LINES):
        if index:
            content.append("0 -16 Td")
        safe = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        content.append(f"({safe}) Tj")
    content.append("ET")
    stream = "\n".join(content).encode("latin-1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size "
        + str(len(objects) + 1).encode()
        + b" /Root 1 0 R >>\nstartxref\n"
        + str(xref_at).encode()
        + b"\n%%EOF\n"
    )
    return bytes(out)
