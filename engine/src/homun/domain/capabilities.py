"""Capability registry: the single source of truth for what the engine can run.

Being registered, existing and authorized are distinct concepts (the Hermes
lesson): this module only *describes* capabilities. Policies decide access,
approval binds arguments and revisions, execution writes effects. Nothing here
grants permissions.
"""
from typing import Literal, Mapping

from homun.domain.errors import ValidationError

CapabilityKind = Literal['executable', 'preparation']


class CapabilitySpec:
    """Immutable description of one engine capability."""

    __slots__ = ('id', 'kind', 'tool_version', 'summary', 'inputs', 'outputs',
                 'effects', 'prerequisites', 'limits', 'timeout_seconds', 'fallback_collaborator')

    def __init__(self, *, id, kind, tool_version, summary, inputs=(), outputs=(),
                 effects=(), prerequisites=(), limits=None, timeout_seconds=0,
                 fallback_collaborator=None):
        self.id = id
        self.kind = kind
        self.tool_version = tool_version
        self.summary = summary
        self.inputs = tuple(inputs)
        self.outputs = tuple(outputs)
        self.effects = tuple(effects)
        self.prerequisites = tuple(prerequisites)
        self.limits = dict(limits or {})
        self.timeout_seconds = timeout_seconds
        self.fallback_collaborator = dict(fallback_collaborator or {})

    def public(self):
        return {
            'id': self.id, 'kind': self.kind, 'tool_version': self.tool_version,
            'summary': self.summary, 'inputs': list(self.inputs), 'outputs': list(self.outputs),
            'effects': list(self.effects), 'prerequisites': list(self.prerequisites),
            'limits': dict(self.limits), 'timeout_seconds': self.timeout_seconds,
        }


MAX_CSV_BYTES = 2 * 1024 * 1024
MAX_CSV_ROWS = 10000
MAX_COMPARISON_ATTEMPTS = 3

COMPARE_CSV = CapabilitySpec(
    id='compare_csv',
    kind='executable',
    tool_version='price-comparison-v1',
    summary='Confronto deterministico di due CSV con SKU e prezzi, senza conversione valute.',
    inputs=('Due materiali CSV attivi gestiti dal motore, con colonne sku, name, price, currency.',),
    outputs=('Report Markdown delle differenze', 'CSV delle differenze'),
    effects=('Produce un artifact nel lavoro e lo lascia in revisione umana; nessun invio esterno.',),
    prerequisites=('Intake confermato con capability compare_csv',
                   "Lettura dei progetti contenenti i due materiali, da parte di chi propone e di chi approva"),
    limits={'max_bytes_per_material': MAX_CSV_BYTES, 'max_rows': MAX_CSV_ROWS,
            'max_attempts': MAX_COMPARISON_ATTEMPTS},
    timeout_seconds=300,
    fallback_collaborator={
        'name': 'Aurora',
        'role': 'Confronto deterministico dei listini caricati',
        'instructions': ('Confronta i due listini assegnati usando solo gli strumenti autorizzati dal motore '
                         'e consegna report e CSV delle differenze per la revisione umana. Non inviare nulla '
                         'a servizi esterni e non convertire le valute.'),
    },
)

GENERAL = CapabilitySpec(
    id='general',
    kind='preparation',
    tool_version='general-v1',
    summary='Preparazione del lavoro: pianificazione e accordo in chat, senza strumenti di esecuzione automatica.',
    inputs=(),
    outputs=('Bozza di piano concordata in conversazione'),
    effects=(),
    prerequisites=(),
    limits={},
    timeout_seconds=0,
)

MAX_READ_BYTES = 2 * 1024 * 1024
MAX_READ_CHARACTERS = 8000
MAX_READ_ATTEMPTS = 3

READ_MATERIAL = CapabilitySpec(
    id='read_material',
    kind='executable',
    tool_version='material-read-v1',
    summary='Lettura autorizzata di un materiale gestito dal motore, con estratto limitato e provenienza.',
    inputs=('Un materiale attivo gestito dal motore: testo, CSV o PDF entro i limiti di dimensione.',),
    outputs=('Artifact di lettura con estratto limitato, hash e provenienza del materiale'),
    effects=('Produce un artifact nel lavoro e lo lascia in revisione umana; nessun invio esterno; il materiale non viene modificato.',),
    prerequisites=('Intake confermato con capability read_material',
                   "Lettura del progetto contenente il materiale, da parte di chi propone e di chi approva"),
    limits={'max_bytes_per_material': MAX_READ_BYTES, 'max_extract_characters': MAX_READ_CHARACTERS,
            'max_attempts': MAX_READ_ATTEMPTS},
    timeout_seconds=120,
)

MAX_SYNTHESIS_MATERIALS = 6
MAX_SYNTHESIS_BYTES = 2 * 1024 * 1024
MAX_SYNTHESIS_CONTEXT_CHARACTERS = 24000
MAX_SYNTHESIS_OUTPUT_CHARACTERS = 8000
MAX_SYNTHESIS_ATTEMPTS = 2

SYNTHESIZE = CapabilitySpec(
    id='synthesize',
    kind='executable',
    tool_version='model-synthesis-v1',
    summary='Sintesi o redazione scritta dal modello del collaboratore assegnato, su obiettivo, materiali e procedure approvate.',
    inputs=('Il lavoro con materiali attivi facoltativi (testo, CSV, PDF entro i limiti) e le procedure approvate pertinenti',),
    outputs=('Artifact di sintesi in Markdown, in revisione umana',),
    effects=('Chiama il modello del collaboratore assegnato a questa fase; produce un artifact nel lavoro e lo lascia in revisione umana; nessun invio esterno.',),
    prerequisites=('Intake confermato con capability synthesize',
                   'Lettura del progetto contenente i materiali, da parte di chi propone e di chi approva'),
    limits={'max_materials': MAX_SYNTHESIS_MATERIALS,
            'max_bytes_per_material': MAX_SYNTHESIS_BYTES,
            'max_context_characters': MAX_SYNTHESIS_CONTEXT_CHARACTERS,
            'max_output_characters': MAX_SYNTHESIS_OUTPUT_CHARACTERS,
            'max_attempts': MAX_SYNTHESIS_ATTEMPTS},
    timeout_seconds=300,
    fallback_collaborator={
        'name': 'Elena',
        'role': 'Redazione di sintesi e documenti a partire dai materiali del lavoro',
        'instructions': ('Scrivi la sintesi richiesta usando solo i materiali e le informazioni autorizzati del lavoro, '
                         'con la tua connessione modello. Cita le fonti dei dati, dichiara i limiti di quello che non '
                         'sai e consegna la bozza per la revisione umana. Non inviare nulla a servizi esterni.'),
    },
)

REGISTRY: Mapping[str, CapabilitySpec] = {spec.id: spec for spec in (COMPARE_CSV, READ_MATERIAL, SYNTHESIZE, GENERAL)}
TRANSPORT_IDS = ('compare_csv', 'read_material', 'synthesize', 'general')
"""Public capability ids accepted by the intake transport; keep in sync with REGISTRY."""


def require_capability(capability_id):
    spec = REGISTRY.get(capability_id)
    if spec is None:
        raise ValidationError(f'Unknown capability: {capability_id}')
    return spec
