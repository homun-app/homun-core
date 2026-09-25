import os
import pytest
from homun.domain.errors import PermissionDeniedError, ValidationError


def test_scoped_read_and_bounded_listing(tmp_path):
    from homun.execution.files import WorkspaceFiles
    (tmp_path/'note.txt').write_text('Ciao mondo')
    files=WorkspaceFiles(tmp_path)
    assert files.read('note.txt')==b'Ciao mondo'
    assert files.list()['items'][0]['name']=='note.txt'


@pytest.mark.parametrize('name',['../secret','/etc/passwd','a/../secret','a\\secret'])
def test_path_escape_is_rejected(tmp_path,name):
    from homun.execution.files import WorkspaceFiles
    with pytest.raises(PermissionDeniedError):WorkspaceFiles(tmp_path).read(name)


def test_symlink_fifo_and_hardlink_are_not_read(tmp_path):
    from homun.execution.files import WorkspaceFiles
    (tmp_path/'target').write_text('private')
    (tmp_path/'link').symlink_to(tmp_path/'target')
    os.mkfifo(tmp_path/'pipe')
    os.link(tmp_path/'target',tmp_path/'hard')
    for name in ['link','pipe','hard']:
        with pytest.raises(PermissionDeniedError):WorkspaceFiles(tmp_path).read(name)


def test_intermediate_symlink_and_size_limit(tmp_path):
    from homun.execution.files import WorkspaceFiles
    (tmp_path/'dir').mkdir();(tmp_path/'dir'/'big').write_bytes(b'x'*20)
    (tmp_path/'alias').symlink_to(tmp_path/'dir',target_is_directory=True)
    with pytest.raises(PermissionDeniedError):WorkspaceFiles(tmp_path).read('alias/big')
    with pytest.raises(ValidationError):WorkspaceFiles(tmp_path).read('dir/big',max_bytes=10)


def test_file_mutation_during_read_is_detected(tmp_path,monkeypatch):
    from homun.execution.files import WorkspaceFiles,FileChangedError
    path=tmp_path/'file';path.write_bytes(b'original');original=os.read;first=True
    def changed(fd,n):
        nonlocal first
        data=original(fd,n)
        if first:first=False;path.write_bytes(b'changed!')
        return data
    monkeypatch.setattr(os,'read',changed)
    with pytest.raises(FileChangedError):WorkspaceFiles(tmp_path).read('file')


def test_list_reports_incomplete_results(tmp_path):
    from homun.execution.files import WorkspaceFiles
    for i in range(3):(tmp_path/str(i)).write_text(str(i))
    result=WorkspaceFiles(tmp_path).list(limit=2)
    assert result['truncated'] and len(result['items'])==2


def test_document_extractors_docx_xlsx_pptx():
    import io
    import zipfile
    from homun.materials.extract import extract_text, EXTRACTED

    # 1. Test DOCX
    docx_buf = io.BytesIO()
    with zipfile.ZipFile(docx_buf, "w") as zf:
        zf.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body><w:p><w:t>Hello DOCX Paragraph 1</w:t></w:p>'
            '<w:p><w:t>Paragraph 2 Content</w:t></w:p></w:body></w:document>',
        )
    res_docx = extract_text(docx_buf.getvalue(), filename="document.docx")
    assert res_docx.status == EXTRACTED
    assert "Hello DOCX Paragraph 1" in res_docx.text
    assert "Paragraph 2 Content" in res_docx.text

    # 2. Test XLSX
    xlsx_buf = io.BytesIO()
    with zipfile.ZipFile(xlsx_buf, "w") as zf:
        zf.writestr(
            "xl/sharedStrings.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<si><t>Item A</t></si><si><t>Item B</t></si></sst>',
        )
        zf.writestr(
            "xl/worksheets/sheet1.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetData>'
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c></row>'
            '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>200</v></c></row>'
            '</sheetData></worksheet>',
        )
    res_xlsx = extract_text(xlsx_buf.getvalue(), filename="table.xlsx")
    assert res_xlsx.status == EXTRACTED
    assert "Item A, 100" in res_xlsx.text
    assert "Item B, 200" in res_xlsx.text

    # 3. Test PPTX
    pptx_buf = io.BytesIO()
    with zipfile.ZipFile(pptx_buf, "w") as zf:
        zf.writestr(
            "ppt/slides/slide1.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide 1 Title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        )
        zf.writestr(
            "ppt/slides/slide2.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
            '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Slide 2 Bullet</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        )
    res_pptx = extract_text(pptx_buf.getvalue(), filename="slides.pptx")
    assert res_pptx.status == EXTRACTED
    assert "[Slide 1]" in res_pptx.text
    assert "Slide 1 Title" in res_pptx.text
    assert "[Slide 2]" in res_pptx.text
    assert "Slide 2 Bullet" in res_pptx.text

