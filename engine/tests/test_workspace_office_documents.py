import io
import zipfile
from homun.execution.file_documents import extract


def package(files):
    target = io.BytesIO()
    with zipfile.ZipFile(target,'w') as archive:
        for name, data in files.items(): archive.writestr(name,data)
    return target.getvalue()


def test_workspace_xlsx_reads_every_sheet_and_inline_strings():
    xml = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>{}</t></is></c><c><v>42</v></c></row></sheetData></worksheet>'
    result=extract('report.xlsx',package({'xl/worksheets/sheet2.xml':xml.format('Second'),'xl/worksheets/sheet1.xml':xml.format('First')}))
    assert result['status']=='extracted'
    assert 'First, 42' in result['text'] and 'Second, 42' in result['text']
    assert result['text'].index('First') < result['text'].index('Second')


def test_workspace_pptx_extracts_real_slide_text():
    data=package({'ppt/slides/slide1.xml':'<p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Actual slide</a:t></p>'})
    result=extract('deck.pptx',data)
    assert result['status']=='extracted' and 'Actual slide' in result['text']


def test_office_entity_declarations_are_rejected():
    data=package({'ppt/slides/slide1.xml':'<!DOCTYPE p [<!ENTITY a "secret">]><p>&a;</p>'})
    assert extract('deck.pptx',data)['status']=='failed'


def test_xlsx_preserves_coordinates_and_workbook_order():
    worksheet='<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1"><v>100</v></c><c r="C1"><v>300</v></c></row></sheetData></worksheet>'
    data=package({'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Second first" r:id="s2"/><sheet name="First last" r:id="s1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="s2" Target="worksheets/sheet2.xml"/><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml':worksheet,'xl/worksheets/sheet2.xml':worksheet})
    result=extract('table.xlsx',data)
    assert result['status']=='extracted'
    assert result['text'].index('Second first') < result['text'].index('First last')
    assert 'A1=100, C1=300' in result['text']


def test_material_docx_uses_same_safe_xml_parser():
    from homun.materials.extract import extract_text
    data=package({'word/document.xml':'<!DOCTYPE p [<!ENTITY a "secret">]><p>&a;</p>'})
    assert extract_text(data,filename='document.docx').status=='failed'
