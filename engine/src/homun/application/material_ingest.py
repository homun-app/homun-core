"""Prepare uploads outside the domain, then atomically register their metadata."""
import hashlib
from pathlib import PurePosixPath

from homun.domain.errors import ValidationError
from homun.materials.extract import extract_text
from homun.materials.managed_blobs import collect_unreferenced, materials_lock, publish
from homun.policy import require_project_capability

MAX_UPLOAD_BYTES = 25 * 1024 * 1024


class MaterialTooLargeError(ValidationError):
    code = 'material_too_large'


def _references(store):
    return {m.storage_relpath for m in store.materials.values() if m.storage_relpath}


def recover_materials(ctx) -> list[str]:
    with materials_lock(ctx.data_dir):
        return collect_unreferenced(ctx.data_dir, _references(ctx.repository.load()))


def ingest_file(ctx, actor, *, command_id, project_id, filename, data,
                title=None, relative_path=None, mime_type=None):
    if len(data) > MAX_UPLOAD_BYTES:
        raise MaterialTooLargeError(f'Material exceeds {MAX_UPLOAD_BYTES} bytes')
    if not command_id.strip() or len(command_id) > 200:
        raise ValidationError('Invalid material command identity')
    require_project_capability(ctx.repository.load(), actor, project_id, 'write')
    rel = relative_path.strip() if relative_path and relative_path.strip() else None
    fname = (filename or rel or 'upload').strip()
    display = (title or rel or fname).strip()
    digest = hashlib.sha256(data).hexdigest()
    extracted = extract_text(data, filename=fname, mime_type=mime_type)
    payload = dict(project_id=project_id, title=display, origin_name=PurePosixPath(fname).name,
                   relative_path=rel, content_hash=digest, byte_size=len(data),
                   text=extracted.text, mime_type=extracted.mime_type, extract_status=extracted.status,
                   filename=fname, declared_mime_type=mime_type,
                   storage_relpath=f'materials/content/{digest}/original')
    with materials_lock(ctx.data_dir):
        created = False
        try:
            with ctx.repository.transaction() as store:
                service = ctx.service.for_store(store)
                result = service.register_prepared_material(actor, command_id, payload)
                _, created = publish(ctx.data_dir, data, digest)
            ctx.service.store = store
        except BaseException:
            if created:
                # The transaction has rolled back. Never remove shared originals.
                # Failure to reload leaves the orphan for startup recovery.
                collect_unreferenced(ctx.data_dir, _references(ctx.repository.load()))
            raise
        # The material is durably stored; a failed announcement must not turn the
        # honest success into a lie. The panel keeps live readiness either way.
        from homun.application.plan_readiness import announce_ready_steps
        try:
            announce_ready_steps(ctx, actor, project_id=project_id, command_id=command_id)
        except Exception:
            pass
        return result
