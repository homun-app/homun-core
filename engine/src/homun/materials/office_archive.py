"""Bounded OOXML reads shared by material and workspace extraction."""
from xml.etree import ElementTree

MAX_EXPANDED_BYTES = 32 * 1024 * 1024
MAX_MEMBERS = 4096


def validate_archive(archive):
    members = archive.infolist()
    if len(members) > MAX_MEMBERS or sum(m.file_size for m in members) > MAX_EXPANDED_BYTES:
        raise ValueError('Office archive exceeds extraction limits')


def read_xml(archive, name):
    data = archive.read(name)
    # Remove NULs as well to detect UTF-16 declarations before parsing.
    folded = data.replace(b'\x00', b'').upper()
    if b'<!DOCTYPE' in folded or b'<!ENTITY' in folded:
        raise ValueError('XML declarations are not allowed')
    return ElementTree.fromstring(data)


def workbook_sheets(archive):
    """Preserve workbook order/names rather than ZIP or filename order."""
    import posixpath
    names = set(archive.namelist())
    if 'xl/workbook.xml' not in names:
        return [(n, n) for n in sorted((n for n in names if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')),
                key=lambda n: int(''.join(filter(str.isdigit, n)) or 0))]
    root = read_xml(archive, 'xl/workbook.xml')
    rels = read_xml(archive, 'xl/_rels/workbook.xml.rels')
    targets = {r.get('Id'): r.get('Target') for r in rels if r.get('TargetMode') != 'External'}
    found = []
    for sheet in root.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet'):
        target = targets.get(sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'))
        if not target:
            raise ValueError('Missing workbook sheet relationship')
        path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
        if not path.startswith('xl/worksheets/') or path not in names:
            raise ValueError('Invalid workbook sheet relationship')
        found.append((path, sheet.get('name') or path))
    return found
