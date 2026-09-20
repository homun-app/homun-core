import csv
import importlib
import io

import pytest

from homun.domain.errors import ValidationError


def compare(left, right, **kwargs):
    module = importlib.import_module('homun.tools.price_comparison')
    return module.compare_csv(left.encode('utf-8') if isinstance(left, str) else left,
                              right.encode('utf-8') if isinstance(right, str) else right, **kwargs)


HEADER = 'sku,name,price,currency\n'


def test_exact_decimal_oracle_and_all_statuses():
    result = compare(HEADER + 'A,Alpha,0.10,EUR\nB,Beta,10,EUR\nC,C,0,EUR\nD,D,1,EUR\nE,E,2,EUR\n',
                     HEADER + 'A,Alpha,0.30,EUR\nB,Beta,9.99,EUR\nC,C,1,EUR\nD,D,1.00,EUR\nF,F,2,EUR\n')
    rows = {row['sku']: row for row in result['rows']}
    assert result['summary']['counts'] == dict(new=1, removed=1, increased=2, decreased=1, unchanged=1, excluded=0)
    assert (rows['A']['delta'], rows['A']['delta_percent']) == ('0.20', '200.00')
    assert (rows['B']['delta'], rows['B']['delta_percent']) == ('-0.01', '-0.10')
    assert rows['C']['delta_percent'] is None
    assert rows['A']['left_rows'] == [2]
    assert result['summary']['anomalies'] == []


def test_semicolon_bom_trim_and_case_sensitive_identity():
    result = compare('\ufeffsku;name;price;currency\n A ;Alpha;1.20; EUR \n', HEADER + 'a,alpha,2,EUR\n')
    assert [(row['sku'], row['status']) for row in result['rows']] == [('A', 'removed'), ('a', 'new')]


def test_invalid_and_duplicate_skus_never_become_new_or_removed():
    result = compare(HEADER + 'A,a,,EUR\nB,b,1,EUR\nB,b,2,EUR\nC,c,NaN,EUR\nD,d,-1,EUR\nE,e,1.234,EUR\n,blank,2,EUR\n',
                     HEADER + ''.join(f'{sku},ok,3,EUR\n' for sku in 'ABCDE'))
    assert all(row['status'] == 'excluded' for row in result['rows'])
    assert result['summary']['left_rows'] == 7
    assert {a['code'] for a in result['summary']['anomalies']} >= {'missing_price', 'invalid_price', 'duplicate_sku', 'blank_sku'}
    assert next(row for row in result['rows'] if row['sku'] == 'B')['left_rows'] == [3, 4]


def test_currency_and_malformed_cells_block_affected_sku():
    result = compare(HEADER + 'A,a,1,EUR\nB,b,1\nC,c,1,\n', HEADER + 'A,a,2,USD\nB,b,2,EUR\nC,c,2,EUR\n')
    assert result['summary']['counts']['excluded'] == 3
    assert {a['code'] for a in result['summary']['anomalies']} >= {'currency_mismatch', 'column_count', 'missing_currency'}


@pytest.mark.parametrize('payload', [b'', b'wrong,header\na,b\n', b'\xff', b'sku,name,price,currency\nA,"unterminated,1,EUR\n', b'sku,name,price,currency,sku\n'])
def test_bad_file_is_typed_failure(payload):
    with pytest.raises(ValidationError):
        compare(payload, HEADER)


def test_limits_count_invalid_and_blank_records_across_both_files():
    with pytest.raises(ValidationError):
        compare(HEADER + '\nA,a,1,EUR\n', HEADER + 'B,b,,EUR\n', max_rows=2)
    with pytest.raises(ValidationError):
        compare(b'x' * (2 * 1024 * 1024 + 1), HEADER)
    with pytest.raises(ValidationError):
        compare(HEADER, HEADER, max_rows=0)


def test_untrusted_text_is_escaped_in_markdown_and_csv():
    left = HEADER + '=CMD(),"<script>|[x](https://bad)\n## evil",1,EUR\n'
    result = compare(left, HEADER)
    assert '<script>' not in result['report_markdown']
    assert '[x](https://bad)' not in result['report_markdown']
    assert '\n## evil' not in result['report_markdown']
    exported = list(csv.DictReader(io.StringIO(result['report_csv'])))
    assert exported[0]['sku'] == "'=CMD()"
    assert result['rows'][0]['sku'] == '=CMD()'
    assert compare(left, HEADER) == result


@pytest.mark.parametrize('price', ['Infinity', '-0', '1e2', '1,23', '.50', '1.', '+1', '0.001'])
def test_non_canonical_prices_are_visible_anomalies(price):
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(['sku', 'name', 'price', 'currency'])
    writer.writerow(['A', 'Product', price, 'EUR'])
    result = compare(stream.getvalue(), HEADER + 'A,Product,1,EUR\n')
    assert result['rows'][0]['status'] == 'excluded'
    assert result['summary']['anomalies'][0]['code'] == 'invalid_price'


def test_multiline_record_source_refs_and_exact_row_budget():
    result = compare(HEADER + 'A,"first\nsecond",3,EUR\nB,B,1,EUR\n',
                     HEADER + 'A,A,4,EUR\nB,B,1,EUR\n', max_rows=4)
    assert result['rows'][1]['left_rows'] == [4]
    assert result['rows'][0]['delta_percent'] == '33.33'
    assert result['summary']['left_rows'] == 2


def test_header_only_inputs_and_formula_names():
    assert compare(HEADER, HEADER)['rows'] == []
    result = compare(HEADER + 'A,  @SUM(1),1,EUR\n', HEADER)
    assert list(csv.DictReader(io.StringIO(result['report_csv'])))[0]['name'] == "'@SUM(1)"


def test_huge_finite_prices_do_not_use_default_decimal_precision():
    old = '9' * 50 + '.98'
    new = '9' * 50 + '.99'
    result = compare(HEADER + f'A,A,{old},EUR\n', HEADER + f'A,A,{new},EUR\n')
    assert result['rows'][0]['delta'] == '0.01'
    assert result['rows'][0]['right_price'] == new
