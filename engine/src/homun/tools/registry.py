"""Run-scoped tool contracts, validation and dispatch.

Tool registry architecture: one entry owns its
schema, toolset and handler. Homun deliberately has no global registration,
module discovery, availability probes, or exception-to-success conversion.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256
import json
from typing import Any, Callable, Literal

from pydantic import BaseModel, ValidationError as PydanticValidationError
from pydantic_core import SchemaSerializer, SchemaValidator

from homun.domain.errors import ConflictError, ValidationError as DomainValidationError
from homun.models.agent_turn import ToolDefinition


@dataclass(frozen=True)
class ToolEntry:
    definition: ToolDefinition
    toolset: str
    version: str
    arguments_model: type[BaseModel]
    handler: Callable[..., dict[str, Any]] | None = None
    kind: Literal['tool', 'ask'] = 'tool'
    replay: Literal['read_only', 'model', 'never'] = 'read_only'


@dataclass(frozen=True)
class _RegisteredTool:
    definition_json: str
    metadata_json: str
    validator: SchemaValidator
    serializer: SchemaSerializer
    handler: Callable[..., dict[str, Any]] | None


class ToolRegistry:
    """An explicitly constructed catalog; create one for each execution run."""

    def __init__(self) -> None:
        self._entries: dict[str, _RegisteredTool] = {}

    def register(self, entry: ToolEntry) -> None:
        definition = entry.definition.model_copy(deep=True)
        if definition.name in self._entries:
            raise ConflictError(f'Tool already registered: {definition.name}')
        if (not definition.name.strip() or not entry.toolset.strip() or not entry.version.strip()
                or entry.kind not in ('tool', 'ask')
                or entry.replay not in ('read_only', 'model', 'never')):
            raise DomainValidationError('Invalid tool registration metadata')
        schema_json = json.dumps(definition.input_schema, sort_keys=True, separators=(',', ':'))
        definition_json = json.dumps(definition.model_dump(mode='json'), sort_keys=True, separators=(',', ':'))
        metadata = {'name': definition.name, 'toolset': entry.toolset,
                    'version': entry.version, 'schema_hash': sha256(schema_json.encode()).hexdigest(),
                    'definition_hash': sha256(definition_json.encode()).hexdigest(),
                    'kind': entry.kind, 'replay': entry.replay}
        # Compile a private schema snapshot: caller rebuilds/config changes must
        # not silently alter a run's pinned validation contract.
        core_schema = deepcopy(entry.arguments_model.__pydantic_core_schema__)
        validator = SchemaValidator(core_schema)
        serializer = SchemaSerializer(core_schema)
        self._entries[definition.name] = _RegisteredTool(
            definition.model_dump_json(), json.dumps(metadata), validator, serializer, entry.handler)

    def unregister(self, name: str) -> None:
        if name in self._entries:
            del self._entries[name]

    def definitions(self) -> list[ToolDefinition]:
        return [ToolDefinition.model_validate_json(self._entries[name].definition_json)
                for name in sorted(self._entries)]

    def manifest(self) -> list[dict[str, Any]]:
        return [json.loads(self._entries[name].metadata_json) for name in sorted(self._entries)]

    def validate_manifest(self, pinned: list[dict[str, Any]]) -> None:
        if pinned != self.manifest():
            raise ConflictError('Tool manifest differs from the pinned run contract')

    def _get(self, name: str) -> _RegisteredTool:
        if not isinstance(name, str) or name not in self._entries:
            raise DomainValidationError(f'Unknown tool: {name}')
        return self._entries[name]

    def validate(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        entry = self._get(name)
        if not isinstance(arguments, dict):
            raise DomainValidationError(f'Arguments for {name} must be an object')
        try:
            validated = entry.validator.validate_python(deepcopy(arguments), strict=True)
        except PydanticValidationError as exc:
            raise DomainValidationError(f'Invalid arguments for {name}') from exc
        return entry.serializer.to_python(validated, mode='json')

    def dispatch(self, name: str, arguments: dict[str, Any], *,
                 ctx: Any, actor: Any, run: Any) -> dict[str, Any]:
        entry = self._get(name)
        validated = self.validate(name, arguments)
        if entry.handler is None:
            raise DomainValidationError(f'Tool has no dispatch handler: {name}')
        return entry.handler(ctx, actor, run, validated)

    def search(self, query: str, limit: int = 5, *, exclude: tuple[str, ...] = ()) -> list[dict[str, Any]]:
        """Search only this run's metadata; never probe or execute a tool."""
        if not isinstance(query, str) or not isinstance(limit, int) or isinstance(limit, bool):
            raise DomainValidationError('Search requires a text query and integer limit')
        if limit <= 0:
            return []
        from homun.tools.search import ranked
        entries = []
        for name in sorted(self._entries):
            if name in exclude:
                continue
            entry = self._entries[name]
            entries.append({**json.loads(entry.definition_json), **json.loads(entry.metadata_json)})
        return ranked(entries, query, min(limit, 100))
