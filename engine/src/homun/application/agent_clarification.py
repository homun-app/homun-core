"""Durable clarification projection through canonical human contributions."""
import json
from homun.application.clarify_tools import _normalize_questions, _batch_result
from homun.domain.errors import ValidationError
from homun.domain.clarification import parse_answers
from pydantic import BaseModel, ConfigDict, Field, ValidationError as SchemaError


class Question(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    id: str | None = Field(default=None, min_length=1, max_length=160)
    question: str = Field(min_length=1, max_length=4000)
    choices: list[str] | None = Field(default=None, max_length=4)
    multi_select: bool = False


def questions(arguments):
    source = arguments.get('questions')
    if source is None:
        source = [{key: arguments[key] for key in ('question', 'choices', 'multi_select') if key in arguments}]
    try:
        if not isinstance(source, list):
            raise ValidationError('Questions must be a list')
        source = [Question.model_validate(q).model_dump() for q in source]
    except SchemaError as exc:
        raise ValidationError('Invalid structured question') from exc
    result, error = _normalize_questions(source)
    if error or not result:
        raise ValidationError(error or 'Clarification requires a question')
    ids = [item['id'] or item['qid'] for item in result]
    if len(ids) != len(set(ids)):
        raise ValidationError('Clarification question IDs must be unique')
    return result


def answer(pending, text, *, resolution=None):
    payload = parse_answers(pending, text)
    if payload is None:
        return {'responses': [], 'text': text, 'unstructured': True}
    answers = payload['answers']
    normalized = {q['qid']: answers[q['id'] or q['qid']] for q in pending if (q['id'] or q['qid']) in answers}
    result = json.loads(_batch_result(pending, normalized, payload.get('timed_out') is True,
                                     'Human response explicitly marked incomplete' if payload.get('timed_out') is True else None))
    if payload.get('partial') is True:
        result['partial'] = True
    if resolution == 'expired':
        result.update(resolution='expired', notice='Clarification deadline expired. Missing input is not approval or consent; do not invent a choice.')
    return result
