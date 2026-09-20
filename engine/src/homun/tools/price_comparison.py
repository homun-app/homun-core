"""Bounded, deterministic price comparison. No provider, filesystem or network I/O."""
from __future__ import annotations

import csv
import html
import io
import re
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP, localcontext

from homun.domain.errors import ValidationError

MAX_BYTES = 2 * 1024 * 1024
_REQUIRED = ('sku', 'name', 'price', 'currency')
_STATUSES = ('new', 'removed', 'increased', 'decreased', 'unchanged', 'excluded')
_LABELS = dict(new='Nuovi', removed='Rimossi', increased='Aumenti', decreased='Ribassi',
               unchanged='Invariati', excluded='Esclusi')
_PRICE = re.compile(r'[0-9]+(?:\.[0-9]{1,2})?\Z')


def _issue(issues, source, row, sku, code, message):
    issues.append(dict(source=source, row=row, sku=sku, code=code, message=message))


def _parse(blob: bytes, source: str, budget: list[int], issues: list[dict]):
    if not isinstance(blob, bytes) or len(blob) > MAX_BYTES:
        raise ValidationError(f'{source}: CSV richiesto in bytes, massimo 2 MiB per file')
    try:
        text = blob.decode('utf-8-sig')
    except UnicodeError as exc:
        raise ValidationError(f'{source}: il CSV deve essere UTF-8') from exc
    if '\x00' in text:
        raise ValidationError(f'{source}: carattere NUL non consentito')
    # Select by the required header, avoiding data-dependent delimiter guesses.
    selected = None
    try:
        for delimiter in (',', ';'):
            reader = csv.reader(io.StringIO(text, newline=''), delimiter=delimiter, strict=True)
            header = next(reader, [])
            header = [cell.strip() for cell in header]
            if set(_REQUIRED).issubset(header) and len(header) == len(set(header)):
                selected = reader, header
                break
        if selected is None:
            raise ValidationError(f'{source}: intestazione richiesta: sku,name,price,currency; senza duplicati')
        reader, header = selected
        records: dict[str, list[dict]] = {}
        count = 0
        while True:
            line = reader.line_num + 1
            cells = next(reader, None)
            if cells is None:
                break
            count += 1
            budget[0] -= 1
            if budget[0] < 0:
                raise ValidationError('Limite righe superato: il limite conta tutte le righe dati di entrambi i file')
            values = dict(zip(header, (cell.strip() for cell in cells)))
            sku = values.get('sku', '')
            valid = True
            if len(cells) != len(header):
                _issue(issues, source, line, sku, 'column_count', 'Numero di colonne diverso dall’intestazione')
                valid = False
            if not sku:
                _issue(issues, source, line, sku, 'blank_sku', 'SKU mancante')
                continue
            price_text = values.get('price', '')
            price = None
            if not price_text:
                _issue(issues, source, line, sku, 'missing_price', 'Prezzo mancante')
                valid = False
            elif not _PRICE.fullmatch(price_text):
                _issue(issues, source, line, sku, 'invalid_price', 'Prezzo non valido: numero non negativo con punto e massimo due decimali')
                valid = False
            else:
                price = Decimal(price_text)
            currency = values.get('currency', '')
            if not currency:
                _issue(issues, source, line, sku, 'missing_currency', 'Valuta mancante')
                valid = False
            records.setdefault(sku, []).append(dict(row=line, name=values.get('name', ''),
                                                    price=price, currency=currency, valid=valid))
        for sku, entries in records.items():
            if len(entries) > 1:
                for entry in entries:
                    entry['valid'] = False
                    _issue(issues, source, entry['row'], sku, 'duplicate_sku', 'SKU duplicato; tutte le occorrenze escluse')
        return records, count
    except csv.Error as exc:
        raise ValidationError(f'{source}: struttura CSV non valida ({exc})') from exc


def _money(value):
    return None if value is None else format(value, '.2f')


def _row(sku, left, right, issues):
    old = left[0] if len(left) == 1 else None
    new = right[0] if len(right) == 1 else None
    invalid = any(not entry['valid'] for entry in left + right)
    mismatch = old and new and old['valid'] and new['valid'] and old['currency'] != new['currency']
    if mismatch:
        _issue(issues, 'comparison', None, sku, 'currency_mismatch',
               'Valute diverse: confronto escluso, nessuna conversione applicata')
    delta = percent = None
    if invalid or mismatch:
        status = 'excluded'
    elif not old:
        status = 'new'
    elif not new:
        status = 'removed'
    else:
        # Enough precision for exact subtraction, even for large valid prices.
        with localcontext() as context:
            context.prec = max(len(old['price'].as_tuple().digits), len(new['price'].as_tuple().digits)) + 12
            delta = new['price'] - old['price']
            if old['price'] != 0:
                percent = (delta / old['price'] * 100).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
            status = 'increased' if delta > 0 else 'decreased' if delta < 0 else 'unchanged'
    chosen = new or old
    currencies = sorted({entry['currency'] for entry in left + right if entry['currency']})
    return dict(sku=sku, name=chosen['name'] if chosen else '', status=status,
                left_price=_money(old['price']) if old else None,
                right_price=_money(new['price']) if new else None,
                currency=' / '.join(currencies), delta=_money(delta), delta_percent=_money(percent),
                left_rows=[entry['row'] for entry in left], right_rows=[entry['row'] for entry in right])


def _markdown_cell(value):
    if value is None:
        return 'n/d'
    text = ' '.join(str(value).split())
    # Entities preserve literal text without making HTML, links or table syntax.
    return ''.join(f'&#{ord(char)};' if char in r'\`*_{}[]()#+-.!|~' else html.escape(char) for char in text)


def _csv_text(value):
    text = '' if value is None else str(value)
    # Excel/LibreOffice formula prefixes, including leading whitespace/control chars.
    if text.lstrip().startswith(('=', '+', '-', '@')) or text.startswith(('\t', '\r', '\n')):
        return "'" + text
    return text


def _render(rows, summary):
    lines = ['# Confronto prezzi', '',
             f"Righe lette: precedente {summary['left_rows']}; aggiornato {summary['right_rows']}.",
             '; '.join(f'{_LABELS[status]}: {summary["counts"][status]}' for status in _STATUSES) + '.',
             f"Anomalie: {summary['anomaly_count']}. Gli SKU esclusi non contribuiscono ai confronti.", '',
             'Identità: SKU esatto dopo rimozione degli spazi esterni; maiuscole e minuscole distinte.',
             'Delta = aggiornato − precedente. Percentuale n/d quando il prezzo precedente è zero.',
             'Nessuna conversione valutaria. Arrotondamento percentuali: due decimali, metà verso l’alto.', '',
             '| SKU | Nome | Esito | Precedente | Aggiornato | Valuta | Delta | Delta % | Righe precedente | Righe aggiornato |',
             '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
    fields = ('sku', 'name', 'status', 'left_price', 'right_price', 'currency', 'delta',
              'delta_percent', 'left_rows', 'right_rows')
    output = io.StringIO(newline='')
    writer = csv.writer(output, lineterminator='\n')
    writer.writerow(fields)
    for row in rows:
        values = [row[field] if field not in ('left_rows', 'right_rows')
                  else ', '.join(map(str, row[field])) for field in fields]
        display = list(values)
        display[2] = _LABELS[row['status']]
        lines.append('| ' + ' | '.join(_markdown_cell(value) for value in display) + ' |')
        writer.writerow([_csv_text(value) if field in ('sku', 'name', 'currency') else value
                         for field, value in zip(fields, values)])
    lines.extend(['', '## Anomalie', ''])
    if not summary['anomalies']:
        lines.append('Nessuna anomalia rilevata.')
    for issue in summary['anomalies']:
        source = dict(left='precedente', right='aggiornato', comparison='confronto')[issue['source']]
        reference = f"{source}, riga {issue['row']}" if issue['row'] is not None else source
        lines.append(f"- {_markdown_cell(reference)}; SKU {_markdown_cell(issue['sku'] or '(vuoto)')}: {_markdown_cell(issue['message'])}.")
    return '\n'.join(lines) + '\n', output.getvalue()


def compare_csv(left: bytes, right: bytes, *, max_rows: int = 10000) -> dict:
    """Compare old/new UTF-8 CSVs; max_rows covers ALL data records across both.

    Format/limit errors raise domain ValidationError. Invalid rows and duplicate
    SKUs remain explicit anomalies; their known SKUs are excluded on both sides.
    Prices use a decimal point, no grouping/exponents, at most two decimal places.
    Source row references are the physical start lines (header starts at line 1).
    """
    if not isinstance(max_rows, int) or isinstance(max_rows, bool) or not 1 <= max_rows <= 10000:
        raise ValidationError('max_rows deve essere un intero fra 1 e 10000, totale sui due file')
    issues: list[dict] = []
    budget = [max_rows]
    previous, left_count = _parse(left, 'left', budget, issues)
    updated, right_count = _parse(right, 'right', budget, issues)
    rows = [_row(sku, previous.get(sku, []), updated.get(sku, []), issues)
            for sku in sorted(previous.keys() | updated.keys())]
    counts = Counter(row['status'] for row in rows)
    summary = dict(left_rows=left_count, right_rows=right_count,
                   counts={status: counts[status] for status in _STATUSES},
                   anomalies=issues, anomaly_count=len(issues))
    markdown, exported_csv = _render(rows, summary)
    return dict(report_markdown=markdown, report_csv=exported_csv, summary=summary, rows=rows)
