"""CLI for the F0.2 kill/resume and uncertain-effect proofs."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from dbos import DBOS

from f0_2_runtime.side_effects import list_receipts
from f0_2_runtime.workflow import (
    configure_dbos,
    data_dir,
    fixture_request_path,
    get_workflow_status,
    receipts_dir,
    send_contribution,
    start_catalog_work,
)


def _launch() -> None:
    configure_dbos()
    DBOS.launch()


def cmd_start(args: argparse.Namespace) -> int:
    _launch()
    if not fixture_request_path().exists():
        print(f"missing fixture: {fixture_request_path()}", file=sys.stderr)
        return 1

    workflow_id = start_catalog_work(
        args.workflow_id,
        crash_after_effect=args.crash_after_effect,
        command_id=args.command_id,
    )
    print(json.dumps({"started": workflow_id, "data_dir": str(data_dir())}))
    print("workflow waiting for contribution on topic 'contribution'", flush=True)

    # Stay alive so DBOS can recover / receive while this process hosts the worker.
    if args.wait:
        print("waiting (Ctrl+C or kill this process to interrupt)...", flush=True)
        try:
            while True:
                status = get_workflow_status(workflow_id)
                if status in {"SUCCESS", "ERROR", "CANCELLED"}:
                    print(json.dumps({"final_status": status}))
                    if status == "SUCCESS":
                        handle = DBOS.retrieve_workflow(workflow_id)
                        print(json.dumps({"result": handle.get_result()}, default=str))
                    return 0 if status == "SUCCESS" else 1
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("interrupted while waiting", flush=True)
            return 130
    return 0


def cmd_contribute(args: argparse.Namespace) -> int:
    _launch()
    material = Path(args.material)
    if not material.exists():
        print(f"missing material: {material}", file=sys.stderr)
        return 1
    send_contribution(args.workflow_id, str(material.resolve()))
    print(json.dumps({"sent": True, "workflow_id": args.workflow_id}))

    if args.wait_result:
        deadline = time.time() + args.timeout
        while time.time() < deadline:
            status = get_workflow_status(args.workflow_id)
            if status in {"SUCCESS", "ERROR", "CANCELLED"}:
                print(json.dumps({"final_status": status}))
                if status == "SUCCESS":
                    handle = DBOS.retrieve_workflow(args.workflow_id)
                    print(json.dumps({"result": handle.get_result()}, default=str))
                    return 0
                return 1
            time.sleep(0.25)
        print("timeout waiting for workflow completion", file=sys.stderr)
        return 1
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    _launch()
    status = get_workflow_status(args.workflow_id)
    print(json.dumps({"workflow_id": args.workflow_id, "status": status}))
    return 0


def cmd_receipts(_: argparse.Namespace) -> int:
    print(json.dumps({"receipts": list_receipts(receipts_dir())}, indent=2))
    return 0


def cmd_reset(_: argparse.Namespace) -> int:
    root = data_dir()
    if root.exists():
        for path in root.rglob("*"):
            if path.is_file():
                path.unlink()
    print(json.dumps({"reset": str(root)}))
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Homun F0.2 runtime validation spike")
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", help="Start catalog workflow and wait for contribution")
    start.add_argument("--workflow-id", default="f0-2-catalog-1")
    start.add_argument("--command-id", default="cmd_publish_1")
    start.add_argument(
        "--crash-after-effect",
        action="store_true",
        help="Simulate timeout after writing the external receipt",
    )
    start.add_argument("--wait", action="store_true", default=True)
    start.add_argument("--no-wait", action="store_false", dest="wait")
    start.set_defaults(func=cmd_start)

    contribute = sub.add_parser("contribute", help="Send human contribution to a waiting workflow")
    contribute.add_argument("--workflow-id", default="f0-2-catalog-1")
    contribute.add_argument(
        "--material",
        default=str(fixture_request_path().parent / "listino.txt"),
    )
    contribute.add_argument("--wait-result", action="store_true", default=True)
    contribute.add_argument("--no-wait-result", action="store_false", dest="wait_result")
    contribute.add_argument("--timeout", type=float, default=30.0)
    contribute.set_defaults(func=cmd_contribute)

    status = sub.add_parser("status", help="Print workflow status")
    status.add_argument("--workflow-id", default="f0-2-catalog-1")
    status.set_defaults(func=cmd_status)

    receipts = sub.add_parser("receipts", help="List uncertain-effect receipts")
    receipts.set_defaults(func=cmd_receipts)

    reset = sub.add_parser("reset", help="Clear local spike data (sqlite + receipts)")
    reset.set_defaults(func=cmd_reset)

    args = parser.parse_args()
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
