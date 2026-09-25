"""REST API routes for deliverable mode, artifact scanning, and channel delivery (H42)."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from homun.application.deliverable_extractor import (
    DeliverableAttachment,
    extract_deliverables_from_text,
)
from homun.application.deliverable_ledger import (
    DeliveryReceipt,
    get_deliverable_ledger,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/deliverables", tags=["deliverables"])


class ScanDeliverablesRequest(BaseModel):
    text: str
    check_exists: Optional[bool] = False


class DeliverableItem(BaseModel):
    path: str
    filename: str
    category: str
    mime_type: str
    exists_on_disk: bool
    size_bytes: int


class ScanDeliverablesResponse(BaseModel):
    cleaned_text: str
    deliverables: List[DeliverableItem]


class RecordDeliveryRequest(BaseModel):
    session_id: str
    channel: str
    path: str
    filename: str
    category: str
    metadata: Optional[Dict[str, Any]] = None


class DeliveryReceiptResponse(BaseModel):
    receipt_id: str
    channel: str
    session_id: str
    path: str
    filename: str
    category: str
    status: str
    delivered_at: float


class DispatchDeliverablesRequest(BaseModel):
    session_id: str
    channel: str
    recipient_id: str
    text: str
    thread_id: Optional[str] = None
    reply_to_id: Optional[str] = None
    check_exists: Optional[bool] = False
    metadata: Optional[Dict[str, Any]] = None


class DispatchDeliverablesResponse(BaseModel):
    cleaned_text: str
    extracted_count: int
    new_deliverables_count: int
    already_delivered_count: int
    receipts: List[DeliveryReceiptResponse]
    delivery_status: str
    delivery_response: Dict[str, Any]



@router.post("/scan", response_model=ScanDeliverablesResponse)
def scan_deliverables(req: ScanDeliverablesRequest) -> ScanDeliverablesResponse:
    """Scan message text for generated deliverable artifacts, ignoring code blocks."""
    cleaned, items = extract_deliverables_from_text(req.text, check_exists=req.check_exists or False)
    return ScanDeliverablesResponse(
        cleaned_text=cleaned,
        deliverables=[
            DeliverableItem(
                path=i.path,
                filename=i.filename,
                category=i.category,
                mime_type=i.mime_type,
                exists_on_disk=i.exists_on_disk,
                size_bytes=i.size_bytes,
            )
            for i in items
        ],
    )


@router.post("/deliver", response_model=DeliveryReceiptResponse)
def record_artifact_delivery(req: RecordDeliveryRequest) -> DeliveryReceiptResponse:
    """Record an artifact delivery receipt in the ledger."""
    ledger = get_deliverable_ledger()
    receipt = ledger.record_delivery(
        session_id=req.session_id,
        channel=req.channel,
        path=req.path,
        filename=req.filename,
        category=req.category,
        metadata=req.metadata,
    )
    return DeliveryReceiptResponse(
        receipt_id=receipt.receipt_id,
        channel=receipt.channel,
        session_id=receipt.session_id,
        path=receipt.path,
        filename=receipt.filename,
        category=receipt.category,
        status=receipt.status,
        delivered_at=receipt.delivered_at,
    )


@router.get("/receipts", response_model=List[DeliveryReceiptResponse])
def list_delivery_receipts(session_id: Optional[str] = None) -> List[DeliveryReceiptResponse]:
    """List delivery receipts for session or across all channels."""
    ledger = get_deliverable_ledger()
    receipts = ledger.list_receipts(session_id=session_id)
    return [
        DeliveryReceiptResponse(
            receipt_id=r.receipt_id,
            channel=r.channel,
            session_id=r.session_id,
            path=r.path,
            filename=r.filename,
            category=r.category,
            status=r.status,
            delivered_at=r.delivered_at,
        )
        for r in receipts
    ]


@router.post("/dispatch", response_model=DispatchDeliverablesResponse)
def dispatch_deliverables(req: DispatchDeliverablesRequest) -> DispatchDeliverablesResponse:
    """Scan message text, protect code blocks, deduplicate against ledger, and dispatch to channel."""
    from homun.application.channel_adapters import ChannelRegistry
    from homun.application.deliverable_dispatcher import dispatch_deliverables_for_turn

    reg = ChannelRegistry()
    adapter = reg.get_adapter(req.channel)

    turn_res = dispatch_deliverables_for_turn(
        session_id=req.session_id,
        platform=req.channel,
        destination_id=req.recipient_id,
        text=req.text,
        adapter=adapter,
        thread_id=req.thread_id,
        reply_to_id=req.reply_to_id,
        check_exists=req.check_exists or False,
        metadata=req.metadata,
    )

    delivery_status = "sent" if turn_res.delivery_response.get("delivered") else (
        "unconfigured" if adapter is None else "failed"
    )

    return DispatchDeliverablesResponse(
        cleaned_text=turn_res.cleaned_text,
        extracted_count=turn_res.extracted_count,
        new_deliverables_count=len(turn_res.new_deliverables),
        already_delivered_count=len(turn_res.already_delivered),
        receipts=[
            DeliveryReceiptResponse(
                receipt_id=r.receipt_id,
                channel=r.channel,
                session_id=r.session_id,
                path=r.path,
                filename=r.filename,
                category=r.category,
                status=r.status,
                delivered_at=r.delivered_at,
            )
            for r in turn_res.receipts
        ],
        delivery_status=delivery_status,
        delivery_response=turn_res.delivery_response,
    )

