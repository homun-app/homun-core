"""Shared admission of managed materials as immutable execution sources.

Both the CSV comparison and the material read bind their approvals to the
material's identity and content hash: if the file changes, the approval is
invalid. Authorization is the caller's read capability on the material's
project, checked here so the two tools cannot diverge.
"""
import hashlib

from homun.domain.errors import ConflictError, NotFoundError, ValidationError
from homun.materials.blob import read_material_blob
from homun.policy import require_project_capability


def verify_material(ctx, store, actor, material_id, *, max_bytes):
    material = store.materials.get(material_id)
    if not material:
        raise NotFoundError('Material not found')
    require_project_capability(store, actor, material.project_id, 'read')
    if material.status != 'active' or not material.storage_relpath or not material.content_hash:
        raise ValidationError('The tool requires active managed file materials')
    if not material.byte_size or material.byte_size > max_bytes:
        raise ValidationError(f'Material must be between 1 byte and {max_bytes} bytes')
    try:
        data = read_material_blob(ctx.data_dir, material.storage_relpath, max_bytes=max_bytes)
    except (OSError, ValueError) as exc:
        raise ConflictError('Material source is unavailable') from exc
    digest = hashlib.sha256(data).hexdigest()
    if digest != material.content_hash or len(data) != material.byte_size:
        raise ConflictError('Material source integrity verification failed')
    return {'id': material.id, 'title': material.title, 'sha256': digest,
            'version': material.version}, data
