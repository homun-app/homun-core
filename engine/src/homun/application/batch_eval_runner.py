"""Batch evaluation and concurrent agent runner for Homun.

Executes bounded benchmark/prompt datasets concurrently with per-batch checkpointing,
tool statistics aggregation, and resume support.
"""

from __future__ import annotations

import concurrent.futures
import json
import logging
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class BatchItem(BaseModel):
    id: str
    prompt: str
    expected: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class BatchItemResult(BaseModel):
    id: str
    success: bool
    output: str
    latency_seconds: float
    tool_stats: Dict[str, Dict[str, int]] = Field(default_factory=dict)
    error: Optional[str] = None


class BatchSummary(BaseModel):
    run_name: str
    total_items: int
    completed_items: int
    failed_items: int
    duration_seconds: float
    aggregated_tool_stats: Dict[str, Dict[str, int]] = Field(default_factory=dict)


class BatchEvalRunner:
    """Executes a bounded batch of evaluation tasks concurrently."""

    def __init__(
        self,
        output_dir: Path,
        max_workers: int = 4,
        task_executor: Optional[Callable[[BatchItem], BatchItemResult]] = None,
    ) -> None:
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.max_workers = max(1, min(16, max_workers))
        self.task_executor = task_executor

    def _merge_tool_stats(
        self,
        total: Dict[str, Dict[str, int]],
        item_stats: Dict[str, Dict[str, int]],
    ) -> None:
        for tool, s in item_stats.items():
            entry = total.setdefault(tool, {"count": 0, "success": 0, "failure": 0})
            entry["count"] += s.get("count", 0)
            entry["success"] += s.get("success", 0)
            entry["failure"] += s.get("failure", 0)

    def run_batch(
        self,
        items: List[BatchItem],
        run_name: str = "eval_run",
        resume: bool = False,
    ) -> Tuple[List[BatchItemResult], BatchSummary]:
        """Execute all items in the batch concurrently with checkpointing."""
        if self.task_executor is None:
            raise ValueError(
                "BatchEvalRunner requires an explicit task_executor. "
                "Homun will not invent successful evaluation results."
            )

        checkpoint_file = self.output_dir / f"{run_name}_checkpoint.jsonl"
        completed_map: Dict[str, BatchItemResult] = {}

        if resume and checkpoint_file.exists():
            with open(checkpoint_file, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        try:
                            data = json.loads(line)
                            res = BatchItemResult(**data)
                            completed_map[res.id] = res
                        except Exception:
                            continue

        remaining_items = [it for it in items if it.id not in completed_map]
        results: List[BatchItemResult] = list(completed_map.values())
        agg_tools: Dict[str, Dict[str, int]] = {}

        for r in results:
            self._merge_tool_stats(agg_tools, r.tool_stats)

        start_time = time.time()

        if remaining_items:
            with concurrent.futures.ThreadPoolExecutor(max_workers=self.max_workers) as pool:
                future_to_item = {
                    pool.submit(self.task_executor, item): item for item in remaining_items
                }
                for future in concurrent.futures.as_completed(future_to_item):
                    item = future_to_item[future]
                    try:
                        res = future.result()
                    except Exception as exc:
                        res = BatchItemResult(
                            id=item.id,
                            success=False,
                            output="",
                            latency_seconds=0.0,
                            error=str(exc),
                        )
                    results.append(res)
                    self._merge_tool_stats(agg_tools, res.tool_stats)

                    with open(checkpoint_file, "a", encoding="utf-8") as f:
                        f.write(json.dumps(res.model_dump()) + "\n")

        duration = round(time.time() - start_time, 2)
        successes = sum(1 for r in results if r.success)
        failures = sum(1 for r in results if not r.success)

        summary = BatchSummary(
            run_name=run_name,
            total_items=len(items),
            completed_items=successes,
            failed_items=failures,
            duration_seconds=duration,
            aggregated_tool_stats=agg_tools,
        )

        return results, summary
