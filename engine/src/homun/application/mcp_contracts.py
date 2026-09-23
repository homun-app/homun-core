"""Pinned MCP descriptors and local-only JSON Schema validation."""
from copy import deepcopy
import json
from jsonschema import Draft202012Validator
from jsonschema.validators import validator_for
from referencing import Registry
from referencing.exceptions import NoSuchResource
from homun.domain.errors import ConflictError, ValidationError


def _no_remote(uri):
    raise NoSuchResource(ref=uri)


def _validator(descriptor):
    try:
        schema = descriptor['inputSchema']
        if not isinstance(schema, dict) or len(json.dumps(schema)) > 65536:
            raise ValueError('Invalid schema')
        stack = [schema]
        while stack:
            node = stack.pop()
            if isinstance(node,dict):
                for key,value in node.items():
                    if key in {'$ref','$dynamicRef','$recursiveRef'} and (not isinstance(value,str) or not value.startswith('#')):
                        raise ValueError('Only local references supported')
                    stack.append(value)
            elif isinstance(node,list):
                stack.extend(node)
        cls = validator_for(schema, default=Draft202012Validator if '$schema' not in schema else None)
        if cls is None:
            raise ValueError('Unsupported dialect')
        cls.check_schema(schema)
        return cls(schema, registry=Registry(retrieve=_no_remote))
    except Exception as exc:
        raise ValidationError('Tool schema is invalid or requires unsupported external references') from exc


def select_descriptor(descriptors, name):
    matches = [d for d in descriptors if isinstance(d,dict) and d.get('name') == name]
    if len(matches) != 1:
        raise ValidationError('Tool discovery must contain one unambiguous matching descriptor')
    _validator(matches[0])
    return deepcopy(matches[0])


def validate_arguments(descriptor, arguments):
    validator = _validator(descriptor)
    try:
        if not isinstance(arguments,dict):
            raise ValueError('Expected object')
        validator.validate(arguments)
    except Exception as exc:
        raise ValidationError('Tool arguments do not match the approved schema') from exc


def require_same_descriptor(expected, actual):
    if expected != actual:
        raise ConflictError('Tool descriptor changed; create a new approval')
