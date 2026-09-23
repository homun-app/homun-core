"""Read-only tools over the sources explicitly bound to an adaptive run."""
from pydantic import BaseModel, ConfigDict, Field, ValidationError as SchemaError
from homun.domain.errors import ConflictError, PermissionDeniedError, ValidationError
from homun.materials.extract import extract_text
from homun.materials.source import verify_material
from homun.models.agent_turn import ToolDefinition

MAX_BYTES = 2 * 1024 * 1024


class NoArguments(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class ReadArguments(NoArguments):
    material_id: str = Field(min_length=1, max_length=160)
    offset: int = Field(default=0, ge=0, le=2000000)
    limit: int = Field(default=6000, ge=1, le=8000)


class SearchArguments(NoArguments):
    query: str = Field(min_length=1, max_length=200)


_SCHEMAS = {'list_materials': NoArguments, 'read_material': ReadArguments,
            'search_materials': SearchArguments}
_DESCRIPTIONS = {
    'list_materials': 'List the files selected for this work, with ids, titles and versions.',
    'read_material': 'Read a page of a selected file. Use its exact material id, never the filename. next_offset indicates more text. Cite title and version.',
    'search_materials': 'Search literal text in selected files, returning up to 12 excerpts and their offsets.',
}


def catalog():
    return [ToolDefinition(name=name, description=_DESCRIPTIONS[name],
                           input_schema=schema.model_json_schema())
            for name, schema in _SCHEMAS.items()]


def validate_sources(ctx, store, actor, bindings):
    for binding in bindings:
        actual, _ = verify_material(ctx, store, actor, binding['id'], max_bytes=MAX_BYTES)
        if actual != binding:
            raise ConflictError('Selected material changed; create a new run proposal')


def _text(ctx, store, actor, binding):
    actual, data = verify_material(ctx, store, actor, binding['id'], max_bytes=MAX_BYTES)
    if actual != binding:
        raise ConflictError('Selected material changed; create a new run proposal')
    material = store.materials[binding['id']]
    extracted = extract_text(data, filename=material.origin_name or material.title,
                             mime_type=material.mime_type)
    if extracted.status != 'extracted':
        raise ValidationError('Material has no readable text')
    return extracted.text


def run_tool(ctx, actor, bindings, name, arguments):
    schema = _SCHEMAS.get(name)
    if schema is None:
        raise ValidationError('Tool is not available')
    try:
        args = schema.model_validate(arguments)
    except SchemaError as exc:
        raise ValidationError('Tool arguments do not match the declared schema') from exc
    store = ctx.repository.load()
    # Even metadata cannot be disclosed after access is revoked.
    validate_sources(ctx, store, actor, bindings)
    if name == 'list_materials':
        return {'materials': bindings}
    if name == 'read_material':
        binding = next((b for b in bindings if b['id'] == args.material_id), None)
        if binding is None:
            raise PermissionDeniedError('Material is outside the approved selection')
        text = _text(ctx, store, actor, binding)
        end = min(len(text), args.offset + args.limit)
        return {'source': binding, 'offset': args.offset, 'text': text[args.offset:end],
                'next_offset': end if end < len(text) else None, 'total_characters': len(text)}
    matches = []
    for binding in bindings:
        text = _text(ctx, store, actor, binding)
        cursor = 0
        while len(matches) < 12:
            pos = text.casefold().find(args.query.casefold(), cursor)
            if pos < 0:
                break
            start = max(0, pos - 120)
            matches.append({'material_id': binding['id'], 'title': binding['title'],
                            'offset': start, 'text': text[start:pos + len(args.query) + 240]})
            cursor = pos + max(1, len(args.query))
        if len(matches) == 12:
            break
    return {'matches': matches, 'limit': 12}
