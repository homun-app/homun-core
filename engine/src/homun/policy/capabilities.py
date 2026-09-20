"""Actual availability of registered capabilities for one actor, now.

The registry describes; this module checks current workspace state (readable,
eligible materials) so collaborator recommendations stay grounded in what the
engine can really run. Availability never grants access by itself.
"""
from homun.domain.capabilities import REGISTRY
from homun.policy import require_project_capability


def _eligible_comparison_material(store, actor, material):
    """Mirrors the comparison source admission: managed, active, within limits."""
    limits = REGISTRY['compare_csv'].limits
    if (material.status != 'active' or not material.storage_relpath
            or not material.content_hash or not material.byte_size
            or material.byte_size > limits['max_bytes_per_material']):
        return False
    try:
        require_project_capability(store, actor, material.project_id, 'read')
    except Exception:
        return False
    return True


def capability_catalog(store, actor):
    """Registry projection with per-actor readiness; no secrets, no grants issued."""
    eligible_csv = sum(1 for material in store.materials.values()
                       if _eligible_comparison_material(store, actor, material))
    items = []
    for spec in REGISTRY.values():
        item = spec.public()
        if spec.id == 'compare_csv':
            item['ready'] = eligible_csv >= 2
            item['eligible_materials'] = eligible_csv
        elif spec.kind == 'preparation':
            item['ready'] = True
        else:
            item['ready'] = False
        items.append(item)
    return items
