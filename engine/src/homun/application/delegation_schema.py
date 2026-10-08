"""Bounded structured child result parsing and validation."""
import json
import jsonschema
from referencing import Registry
from referencing.exceptions import Unresolvable


def validate_output_schema(schema):
    jsonschema.Draft202012Validator.check_schema(schema)
    pending = [schema]
    while pending:
        node = pending.pop()
        if isinstance(node, dict):
            for key in ("$ref", "$dynamicRef"):
                if key in node and not node[key].startswith("#"):
                    raise ValueError("Only local schema references are supported")
            pending.extend(node.values())
        elif isinstance(node, list):
            pending.extend(node)


def _no_remote_reference(uri):
    raise Unresolvable(ref=uri)

def _validate_schema(data: str, schema: dict) -> tuple[dict | None, str | None]:
    """Parse JSON and validate against schema. Returns (parsed_obj, error_string)."""
    try:
        parsed = json.loads(data)
    except Exception:
        # Bounded repair attempt: strip code fences if present
        cleaned = data.strip()
        if cleaned.startswith("```"):
            lines = cleaned.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            cleaned = "\n".join(lines).strip()
        try:
            parsed = json.loads(cleaned)
        except Exception as exc:
            return None, f"Failed to parse output as JSON: {exc}"

    try:
        validate_output_schema(schema)
        jsonschema.Draft202012Validator(schema, registry=Registry(retrieve=_no_remote_reference)).validate(parsed)
        return parsed, None
    except jsonschema.ValidationError as err:
        return parsed, f"Schema validation error: {err.message}"
    except (Unresolvable, jsonschema.SchemaError, ValueError, RecursionError):
        return parsed, "Output schema could not be resolved or validated"


