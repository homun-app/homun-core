"""Deliverable dispatcher for messaging gateway channels (H42).

Derived from Hermes gateway/delivery.py and website/docs/user-guide/features/deliverable-mode.md
at c9dca726514b709cf6e677d236a79fc8d0627f37 (MIT).
Coordinates text deliverable extraction, code-block protection, deduplication against
DeliverableLedger (at-most-once delivery), ChannelMedia preparation, channel adapter delivery,
and durable receipt tracking.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from homun.application.channel_contracts import ChannelAdapter
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

    # 2. Check at-most-once delivery state in ledger
    for item in extracted:
        if dlv_ledger.is_delivered(session_id, item.path):
            already_delivered.append(item)
        else:
            new_deliverables.append(item)

    # 3. Prepare ChannelMedia objects for new deliverables
    media_items: List[ChannelMedia] = [
        ChannelMedia(
            url=item.path,
            mime_type=item.mime_type,
            file_name=item.filename,
            size_bytes=item.size_bytes,
        )
        for item in new_deliverables
    ]

    delivery_response: Dict[str, Any] = {}
    receipts: List[DeliveryReceipt] = []

    # 4. If adapter provided, deliver to channel
    if adapter is not None:
        delivery_response = adapter.send(
            destination_id,
            cleaned_text,
            thread_id=thread_id,
            reply_to_id=reply_to_id,
            media=media_items if media_items else None,
        )

        # 5. Record receipts for newly dispatched deliverables
        delivery_status = "delivered" if delivery_response.get("delivered") else "failed"
        for item in new_deliverables:
            rcp = dlv_ledger.record_delivery(
                session_id=session_id,
                channel=platform,
                path=item.path,
                filename=item.filename,
                category=item.category,
                metadata={
                    **(metadata or {}),
                    "channel_response": delivery_response,
                    "status": delivery_status,
                },
            )
            receipts.append(rcp)
    else:
        # No adapter: only record delivery intent
        for item in new_deliverables:
            rcp = dlv_ledger.record_delivery(
                session_id=session_id,
                channel=platform,
                path=item.path,
                filename=item.filename,
                category=item.category,
                metadata=metadata or {},
            )
            receipts.append(rcp)

    return DeliverableTurnResult(
        cleaned_text=cleaned_text,
        extracted_count=len(extracted),
        new_deliverables=new_deliverables,
        already_delivered=already_delivered,
        receipts=receipts,
        delivery_response=delivery_response,
    )
