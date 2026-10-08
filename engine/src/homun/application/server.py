"""CLI serving policy and parent-owned ephemeral loopback socket."""
import json
import os
import socket
import sys
import logging

import uvicorn
from homun.app import create_app


def _configure_logging(dev: bool) -> None:
    """Traccia applicativa leggibile: un solo formato, livelli sensati.

    HOMUN_LOG_LEVEL=INFO di default; DEBUG per il giro diagnostico completo.
    """
    import os
    level = os.environ.get("HOMUN_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        datefmt="%H:%M:%S",
        force=True,
    )
    for noisy in ("httpx", "httpcore", "dbos", "uvicorn.access", "mcp"):
        logging.getLogger(noisy).setLevel(max(logging.WARNING, getattr(logging, level)))


def serve(args):
    _configure_logging(getattr(args, 'dev_insecure', False))
    token = os.environ.get('HOMUN_SESSION_TOKEN')
    if args.host not in {'127.0.0.1', '::1'}:
        print('The local engine only binds to loopback', file=sys.stderr)
        return 2
    if not token and not args.dev_insecure:
        print('A desktop session is required; browser development requires --dev-insecure', file=sys.stderr)
        return 2
    if token and len(token) < 32:
        print('Invalid local session configuration', file=sys.stderr)
        return 2
    if os.environ.get('HOMUN_PARENT_WATCHDOG') == '1':
        from threading import Thread
        import signal
        import time
        def watch_parent():
            # EOF means the owning desktop disappeared, even after SIGKILL.
            sys.stdin.buffer.read()
            os.kill(os.getpid(), signal.SIGTERM)
            # A wedged graceful shutdown would keep the data-dir lease hostage;
            # escalate like the desktop's own stop() does.
            time.sleep(10)
            os.kill(os.getpid(), signal.SIGKILL)
        Thread(target=watch_parent, daemon=True, name='desktop-owner').start()
    origins = ['homun://app'] if token else ['http://127.0.0.1:4183', 'http://localhost:4183']
    app = create_app(session_token=token, allowed_origins=origins,
                     session_actor_id=os.environ.get('HOMUN_SESSION_ACTOR_ID', 'person_fabio'))
    sock = socket.socket(socket.AF_INET6 if args.host == '::1' else socket.AF_INET)
    # A restart right after a stop hits TIME_WAIT remnants of the old listener;
    # reuse keeps the dev loop (change code, restart) free of spurious binds.
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((args.host, args.port))
        from homun.application.engine_listening import set_listening_port

        # Channel sidecars spawned by the engine call back on this port.
        set_listening_port(sock.getsockname()[1])
        # Reserved socket, not a readiness claim. Parent polls authenticated health.
        print('HOMUN_SOCKET '+json.dumps({'port': sock.getsockname()[1]}), flush=True)
        uvicorn.Server(uvicorn.Config(app, log_level='warning', access_log=False)).run(sockets=[sock])
    finally:
        sock.close()
    return 0
