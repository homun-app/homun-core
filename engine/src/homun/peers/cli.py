"""CLI del peer (F5 pilot): entrare in uno spazio remoto dal terminale.

``homun peer pair --host URL --invite TOKEN --name NOME`` registra il
dispositivo con la propria chiave; ``sync`` porta la proiezione del
progetto condiviso; ``message`` contribuisce; ``assignments`` gestisce le
deleghe. Ogni comando parla con l'engine host via HTTP: su due Mac in VPN
è il percorso del pilot, oggi."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _data_dir(args: argparse.Namespace) -> Path:
    if getattr(args, "data_dir", None):
        return Path(args.data_dir)
    from homun.storage.paths import default_data_dir
    return default_data_dir()


def _connection_or_die(args: argparse.Namespace):
    from homun.peers.store import PeerConnections
    connections = PeerConnections(_data_dir(args))
    connection = connections.connection(args.host)
    if connection is None:
        raise SystemExit(f"Nessuna connessione con {args.host}: prima 'homun peer pair'")
    return connection


def cmd_pair(args: argparse.Namespace) -> int:
    from homun.peers import pair_with_host
    from homun.peers.store import PeerConnections, device_key_path
    data_dir = _data_dir(args)
    connection = pair_with_host(args.host, args.invite, args.name,
                                args.device or f"Terminale di {args.name}",
                                device_key_path(data_dir))
    PeerConnections(data_dir).upsert(
        host=connection.host, workspace_id=connection.workspace_id,
        person_id=connection.person_id, device_id=connection.device_id,
        device_token=connection.device_token,
        key_fingerprint=connection.key_fingerprint, display_name=args.name)
    print(json.dumps({"host": connection.host, "person_id": connection.person_id,
                      "device_id": connection.device_id,
                      "fingerprint": connection.key_fingerprint}, indent=2))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    from homun.peers.outbox import RemoteOutbox
    from homun.peers.store import PeerConnections
    data_dir = _data_dir(args)
    outbox = RemoteOutbox(data_dir / "remote-outbox.db")
    pending = outbox.pending()
    print(json.dumps({
        "connections": PeerConnections(data_dir).list(),
        "outbox_pending": [{"command_id": e["command_id"], "type": e["type"],
                            "host": e["host"], "since": e["created_at"]}
                           for e in pending],
    }, indent=2, ensure_ascii=False))
    return 0


def cmd_projects(args: argparse.Namespace) -> int:
    from homun.peers import remote_request
    connection = _connection_or_die(args)
    page = remote_request(
        connection, f"/v1/workspaces/{connection.workspace_id}/projects")
    print(json.dumps(page, indent=2, ensure_ascii=False))
    return 0


def cmd_sync(args: argparse.Namespace) -> int:
    from homun.peers import sync_remote_project
    from homun.peers.store import peers_db_path
    connection = _connection_or_die(args)
    view = sync_remote_project(connection, peers_db_path(_data_dir(args)), args.project)
    summary = {"source": view["source"], "host": view["host"], "cursor": view["cursor"],
               "project": view["snapshot"].get("project"),
               "conversations": len(view["snapshot"].get("conversations", [])),
               "works": len(view["snapshot"].get("works", [])),
               "events": len(view["events"])}
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


def cmd_message(args: argparse.Namespace) -> int:
    from homun.peers.outbox import RemoteOutbox
    from homun.peers.store import peers_db_path
    connection = _connection_or_die(args)
    outbox = RemoteOutbox(_data_dir(args) / "remote-outbox.db")
    import time
    outbox.enqueue(host=connection.host,
                   command_id=f"peer-msg-{int(time.time()*1000)}",
                   type_="conversation.post_message",
                   payload={"conversation_id": args.conversation, "text": args.text})
    result = outbox.flush(connection)
    print(json.dumps(result, indent=2))
    return 0 if result["pending"] == 0 else 1


def cmd_assignments(args: argparse.Namespace) -> int:
    from homun.peers import remote_request
    connection = _connection_or_die(args)
    assignment_id = getattr(args, "assignment", None)
    if assignment_id:
        page = remote_request(
            connection,
            f"/v1/workspaces/{connection.workspace_id}/remote/assignments/{assignment_id}")
    else:
        page = remote_request(
            connection, f"/v1/workspaces/{connection.workspace_id}/remote/assignments")
    print(json.dumps(page, indent=2, ensure_ascii=False))
    return 0


def _assignment_action(args: argparse.Namespace, action: str, extra: dict[str, Any]) -> int:
    import time
    from homun.peers import remote_request
    connection = _connection_or_die(args)
    payload = {"command_id": f"peer-{action}-{int(time.time()*1000)}", **extra}
    page = remote_request(
        connection,
        f"/v1/workspaces/{connection.workspace_id}/remote/assignments/{args.assignment}/{action}",
        method="POST", payload=payload)
    print(json.dumps(page, indent=2, ensure_ascii=False))
    return 0


def cmd_accept(args: argparse.Namespace) -> int:
    return _assignment_action(args, "accept", {})


def cmd_return(args: argparse.Namespace) -> int:
    result = json.loads(args.result) if args.result.startswith("{") else {"text": args.result}
    return _assignment_action(args, "return",
                              {"result": result, "model_attempts_used": args.attempts})


def cmd_reconcile(args: argparse.Namespace) -> int:
    extra: dict[str, Any] = {}
    if args.result:
        extra["result"] = (json.loads(args.result) if args.result.startswith("{")
                           else {"text": args.result})
    if args.attempts is not None:
        extra["model_attempts_used"] = args.attempts
    return _assignment_action(args, "reconcile", extra)


def add_parser(sub: Any) -> None:
    parser = sub.add_parser("peer", help="Pilot F5: entra in uno spazio remoto")
    parser.add_argument("--data-dir", default=None, help="Data dir del peer (default: quella del motore)")
    commands = parser.add_subparsers(dest="peer_command", required=True)

    pair = commands.add_parser("pair", help="Riscatta un invito e registra il dispositivo")
    pair.add_argument("--host", required=True, help="URL dell'engine host, es. http://192.168.1.10:8765")
    pair.add_argument("--invite", required=True, help="Token d'invito monouso")
    pair.add_argument("--name", required=True, help="Nome della persona")
    pair.add_argument("--device", default=None, help="Nome del dispositivo")
    pair.set_defaults(func=cmd_pair)

    status = commands.add_parser("status", help="Connessioni e outbox del peer")
    status.set_defaults(func=cmd_status)

    projects = commands.add_parser("projects", help="Progetti visibili su un host")
    projects.add_argument("--host", required=True)
    projects.set_defaults(func=cmd_projects)

    sync = commands.add_parser("sync", help="Porta la proiezione di un progetto condiviso")
    sync.add_argument("--host", required=True)
    sync.add_argument("--project", required=True)
    sync.set_defaults(func=cmd_sync)

    message = commands.add_parser("message", help="Contribuisci a una conversazione remota")
    message.add_argument("--host", required=True)
    message.add_argument("--conversation", required=True)
    message.add_argument("--text", required=True)
    message.set_defaults(func=cmd_message)

    assignments = commands.add_parser("assignments", help="Deleghe offerte a te")
    assignments.add_argument("--host", required=True)
    assignments.add_argument("--assignment", default=None,
                             help="Interroga un tentativo precedente per id")
    assignments.set_defaults(func=cmd_assignments)

    accept = commands.add_parser("accept", help="Accetta una delega")
    accept.add_argument("--host", required=True)
    accept.add_argument("--assignment", required=True)
    accept.set_defaults(func=cmd_accept)

    ret = commands.add_parser("return", help="Restituisci il risultato di una delega")
    ret.add_argument("--host", required=True)
    ret.add_argument("--assignment", required=True)
    ret.add_argument("--result", required=True, help="JSON del risultato o testo")
    ret.add_argument("--attempts", default=None, type=int, help="Tentativi modello usati")
    ret.set_defaults(func=cmd_return)

    reconcile = commands.add_parser(
        "reconcile", help="Dopo timeout: interroga e rilascia/liquida la hold")
    reconcile.add_argument("--host", required=True)
    reconcile.add_argument("--assignment", required=True)
    reconcile.add_argument("--result", default=None, help="JSON risultato tardivo opzionale")
    reconcile.add_argument("--attempts", default=None, type=int,
                           help="Tentativi modello usati da liquidare")
    reconcile.set_defaults(func=cmd_reconcile)
