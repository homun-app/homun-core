"""Deliverable dispatcher for messaging gateway channels (H42).

at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Coordinates text deliverable extraction, code-block protection, deduplication against
DeliverableLedger (at-most-once delivery), ChannelMedia preparation, channel adapter delivery,
and durable receipt tracking.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from homun.application.channel_contracts import ChannelAdapter
from homun.application.delivery_outcomes import delivery_status
from homun.application.deliverable_extractor import (
    DeliverableAttachment,
    extract_deliverables_from_text,
)
from homun.application.deliverable_ledger import (
    DeliverableLedger,
    DeliveryReceipt,
    get_deliverable_ledger,
)
from homun.application.gateway_contracts import ChannelMedia

logger = logging.getLogger(__name__)


@dataclass
class DeliverableTurnResult:
    """Outcome of deliverable scanning, deduplication, and channel dispatch."""
    cleaned_text: str
    extracted_count: int
    new_deliverables: List[DeliverableAttachment]
    already_delivered: List[DeliverableAttachment]
    receipts: List[DeliveryReceipt]
    delivery_response: Dict[str, Any]


def dispatch_deliverables_for_turn(
    session_id: str,
    platform: str,
    destination_id: str,
    text: str,
    *,
    adapter: Optional[ChannelAdapter] = None,
    thread_id: Optional[str] = None,
    reply_to_id: Optional[str] = None,
    ledger: Optional[DeliverableLedger] = None,
    check_exists: bool = False,
    allowed_dirs: Optional[List[Path | str]] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> DeliverableTurnResult:
    """Extract deliverables from text, protect code blocks, deduplicate via ledger, and send to channel."""
    dlv_ledger = ledger or get_deliverable_ledger()

    # 1. Extract deliverables while protecting code blocks and inline code
    cleaned_text, extracted = extract_deliverables_from_text(
        text,
        allowed_dirs=allowed_dirs,
        check_exists=check_exists,
    )

    new_deliverables: List[DeliverableAttachment] = []
    already_delivered: List[DeliverableAttachment] = []

    receipts: List[DeliveryReceipt] = []
    claims: List[DeliveryReceipt] = []
    blocked = False
    for item in extracted:
        receipt, acquired = dlv_ledger.claim_delivery(
            session_id, platform, item.path, item.filename, item.category,
            destination_id=destination_id, metadata=metadata, intent=adapter is None,
        )
        if acquired:
            new_deliverables.append(item)
            if adapter is not None:
                claims.append(receipt)
            else:
                receipts.append(receipt)
        elif receipt.status == "delivered":
            already_delivered.append(item)
        else:
            blocked = True
            receipts.append(receipt)

    media_items = [ChannelMedia(url=item.path, mime_type=item.mime_type,
        file_name=item.filename, size_bytes=item.size_bytes) for item in new_deliverables]
    delivery_response: Dict[str, Any] = {}
    if adapter is None:
        delivery_response = {"delivered": False, "code": "backend_unavailable",
                             "delivery_state": "intent"}
    elif blocked and not claims:
        delivery_response = {"delivered": False, "code": "delivery_outcome_unknown",
                             "delivery_state": "unknown"}
    else:
        try:
            response = adapter.send(destination_id, cleaned_text, thread_id=thread_id,
                reply_to_id=reply_to_id, media=media_items or None)
            delivery_response = response if isinstance(response, dict) else {}
            status = delivery_status(delivery_response, has_media=bool(media_items))
            delivery_response = {**delivery_response, "delivery_state": status}
            if status == "unknown":
                delivery_response.update(delivered=False, code="delivery_outcome_unknown")
        except Exception as exc:
            status = "unknown"
            delivery_response = {"delivered": False, "code": "delivery_outcome_unknown",
                "delivery_state": status, "error": str(exc)}
        for receipt in claims:
            receipts.append(dlv_ledger.finish_delivery(receipt, status,
                metadata={"channel_response": delivery_response, "status": status}))

    return DeliverableTurnResult(
        cleaned_text=cleaned_text,
        extracted_count=len(extracted),
        new_deliverables=new_deliverables,
        already_delivered=already_delivered,
        receipts=receipts,
        delivery_response=delivery_response,
    )
