"""Validate human answers before a contribution becomes resolved."""
import json
from homun.domain.errors import ValidationError


def parse_answers(questions, text):
    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        payload = None
    if not isinstance(payload, dict):
        if len(questions) != 1:
            return None  # Preserve a human prose answer without inventing choices.
        return {'answers': {questions[0]['id'] or questions[0]['qid']: text}}
    answers = payload.get('answers')
    if not isinstance(answers, dict):
        raise ValidationError('Clarification answers must be an object keyed by question ID')
    keys = {q['id'] or q['qid'] for q in questions}
    if set(answers) - keys:
        raise ValidationError('Unknown clarification question ID')
    partial = payload.get('partial') is True or payload.get('timed_out') is True
    for q in questions:
        key = q['id'] or q['qid']
        if key not in answers:
            if not partial:
                raise ValidationError('Answer every question or explicitly mark the response partial')
            continue
        value = answers[key]
        if not isinstance(value, (str, list)) or (isinstance(value, list) and not all(isinstance(v, str) for v in value)):
            raise ValidationError('Clarification answer must be text or a list of choices')
        if isinstance(value, list) and not q['multi_select']:
            raise ValidationError('Single-select answer must be text')
        if not value and not partial:
            raise ValidationError('Empty answers must be explicitly marked partial')
    return payload


def validate_form(questions):
    if questions is None:
        return None
    if not isinstance(questions, list) or not 1 <= len(questions) <= 5:
        raise ValidationError('Clarification requires one to five questions')
    keys = set()
    for item in questions:
        if not isinstance(item, dict):
            raise ValidationError('Invalid clarification question')
        key = item.get('id') or item.get('qid')
        if not isinstance(key, str) or not key or key in keys:
            raise ValidationError('Question IDs must be present and unique')
        keys.add(key)
        if not isinstance(item.get('question'), str) or not item['question'].strip():
            raise ValidationError('Question text is required')
        if not isinstance(item.get('multi_select', False), bool):
            raise ValidationError('multi_select must be boolean')
        choices = item.get('choices')
        if choices is not None and (not isinstance(choices, list) or len(choices) > 4 or not all(isinstance(c, str) for c in choices)):
            raise ValidationError('Invalid clarification choices')
    return questions
