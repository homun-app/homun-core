"""Prompt templates as package data, separated from code.

Prompts are engine behavior: they are versioned with the code, shipped in the
bundle and bound by the build receipt. Language variants make the engine
multilingual; the fallback chain (requested language → default → neutral → any
available variant) never breaks a call because a translation is missing.

Placeholder syntax is `{{name}}` replaced literally — no str.format parsing, so
JSON braces in schemas and catalogs stay safe.
"""
from pathlib import Path

PROMPTS_ROOT = Path(__file__).resolve().parent.parent / 'prompts'


class PromptTemplate:
    __slots__ = ('name', 'language', 'text')

    def __init__(self, name, language, text):
        self.name = name
        self.language = language
        self.text = text

    def render(self, **values):
        rendered = self.text
        for key, value in values.items():
            rendered = rendered.replace('{{' + key + '}}', str(value))
        if '{{' in rendered:
            raise ValueError(f'Unresolved placeholder in prompt {self.name} ({self.language})')
        return rendered


class PromptStore:
    def __init__(self, root=PROMPTS_ROOT, default_language='it'):
        self.root = Path(root)
        self.default_language = default_language

    def _read(self, filename):
        path = self.root / filename
        return path.read_text(encoding='utf-8') if path.is_file() else None

    def get(self, name, language=None):
        """Named template in the requested language, with a safe fallback."""
        for lang in (language, self.default_language):
            if lang:
                text = self._read(f'{name}.{lang}.txt')
                if text is not None:
                    return PromptTemplate(name, lang, text)
        neutral = self._read(f'{name}.txt')
        if neutral is not None:
            return PromptTemplate(name, '-', neutral)
        for path in sorted(self.root.glob(f'{name}.*.txt')):
            return PromptTemplate(name, path.name[:-len('.txt')].rsplit('.', 1)[-1],
                                  path.read_text(encoding='utf-8'))
        raise ValueError(f'Prompt template not found: {name}')

    def available(self):
        return sorted(p.name for p in self.root.rglob('*.txt'))


def prompts_for(registry):
    """ModelRegistry owns the configured store; test fakes fall back to defaults."""
    prompts = getattr(registry, 'prompts', None)
    return prompts if isinstance(prompts, PromptStore) else PromptStore()
