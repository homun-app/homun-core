"""CLI entry: serve the engine or run backup/restore (F2.5)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import uvicorn

from homun.app import DEFAULT_HOST, DEFAULT_PORT, create_app
from homun.storage.backup import BackupError, create_backup, restore_backup, verify_backup
from homun.storage.paths import default_data_dir


def _cmd_serve(args: argparse.Namespace) -> int:
    from homun.application.server import serve
    return serve(args)


def _cmd_backup_create(args: argparse.Namespace) -> int:
    workspace_id = args.workspace
    data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else default_data_dir()
    source_db = data_dir / f"{workspace_id}.sqlite3"
    backups_root = Path(args.out).expanduser().resolve() if args.out else data_dir / "backups"
    try:
        if args.full:
            from homun.storage.installation_backup import create_installation_backup
            backup_dir = create_installation_backup(data_dir, backups_root, workspace_id=workspace_id)
        else:
            backup_dir = create_backup(
                workspace_id=workspace_id,
                source_db=source_db,
                backups_root=backups_root,
            )
    except BackupError as exc:
        print(f"backup failed: {exc}", file=sys.stderr)
        return 1
    print(backup_dir)
    return 0


def _cmd_backup_restore(args: argparse.Namespace) -> int:
    backup_dir = Path(args.backup_dir).expanduser().resolve()
    destination = Path(args.to).expanduser().resolve()
    try:
        verify_backup(backup_dir)
        db_path = restore_backup(backup_dir=backup_dir, destination_data_dir=destination)
    except BackupError as exc:
        print(f"restore failed: {exc}", file=sys.stderr)
        return 1
    print(db_path)
    return 0


def _cmd_backup_verify(args: argparse.Namespace) -> int:
    backup_dir = Path(args.backup_dir).expanduser().resolve()
    try:
        manifest = verify_backup(backup_dir)
    except BackupError as exc:
        print(f"verify failed: {exc}", file=sys.stderr)
        return 1
    print(f"ok {manifest.workspace_id} files={len(manifest.files)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Homun local engine")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="Start the HTTP engine (default)")
    serve.add_argument("--host", default=DEFAULT_HOST)
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.add_argument("--dev-insecure", action="store_true", help="Explicit loopback-only browser development without session authentication")
    serve.set_defaults(func=_cmd_serve)

    backup = sub.add_parser("backup", help="Backup and restore workspace SQLite")
    backup_sub = backup.add_subparsers(dest="backup_command", required=True)

    create = backup_sub.add_parser("create", help="Create a consistent backup + manifest")
    create.add_argument("--full", action="store_true", help="Complete offline bundle; stop the engine first")
    create.add_argument("--workspace", default="ws_local")
    create.add_argument("--data-dir", default=None, help="Override HOMUN_DATA_DIR / default path")
    create.add_argument("--out", default=None, help="Backups root (default: <data-dir>/backups)")
    create.set_defaults(func=_cmd_backup_create)

    restore = backup_sub.add_parser("restore", help="Restore into a clean destination directory")
    restore.add_argument("backup_dir", help="Path to a backup folder with manifest.json")
    restore.add_argument("--to", required=True, help="Empty destination data directory")
    restore.set_defaults(func=_cmd_backup_restore)

    verify = backup_sub.add_parser("verify", help="Verify backup checksums")
    verify.add_argument("backup_dir")
    verify.set_defaults(func=_cmd_backup_verify)

    args = parser.parse_args(argv)
    if args.command is None:
        # Backward compatible: `python -m homun` still starts the server.
        return _cmd_serve(argparse.Namespace(host=DEFAULT_HOST, port=DEFAULT_PORT, dev_insecure=False))
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
