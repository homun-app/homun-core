"""Ripristino del workspace: diagnosi tipizzata, salvage chirurgico, avvio garantito.

Un database corrotto (pagine danneggiate o righe che non validano più) non deve
mai impedire l'avvio del motore. Qui si mette in quarantena l'originale, si
ricostruisce un database sano copiando le righe sopravvissute riga per riga e
si registra un rapporto persistente che salute e chat possono mostrare.
Il ripristino è deterministico: nessun modello decide cosa tenere.
"""
from __future__ import annotations

import json
import shutil
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from homun.storage.documents import ENTITY_TYPES
from homun.storage.schema import initialize
from homun.storage.sqlite import _open_connection

RECOVERY_DIRNAME = "recovery"
REPORT_FILENAME = "last-report.json"
QUARANTINE_SUBDIR = "originals"


@dataclass
class RecoveryIssue:
    kind: str  # page_corruption | row_invalid | unreadable_table | unreadable_database
    table: str | None = None
    detail: str = ""
    sample: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "table": self.table,
                "detail": self.detail[:400], "sample": self.sample[:200]}


@dataclass
class RecoveryReport:
    mode: str  # repaired | minimal
    started_at: str = ""
    finished_at: str = ""
    workspace_id: str = ""
    issues: list[RecoveryIssue] = field(default_factory=list)
    # righe salvate per tabella: {table: {"kept": n, "lost": n}}
    tables: dict[str, dict[str, int]] = field(default_factory=dict)
    quarantine_dir: str = ""
    report_path: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "workspace_id": self.workspace_id,
            "issues": [issue.to_dict() for issue in self.issues],
            "tables": self.tables,
            "quarantine_dir": self.quarantine_dir,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def recovery_root(data_dir: Path) -> Path:
    return data_dir / RECOVERY_DIRNAME


def report_path(data_dir: Path) -> Path:
    return recovery_root(data_dir) / REPORT_FILENAME


def last_report(data_dir: Path) -> dict[str, Any] | None:
    path = report_path(data_dir)
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def write_report(data_dir: Path, report: RecoveryReport) -> Path:
    root = recovery_root(data_dir)
    root.mkdir(parents=True, exist_ok=True)
    path = report_path(data_dir)
    path.write_text(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    report.report_path = str(path)
    return path


def clear_report(data_dir: Path) -> None:
    """Un avvio pulito dopo un ripristino precedente conserva la storia:
    il rapporto resta, ma lo stato torna 'ok' (vedi db_state)."""
    path = report_path(data_dir)
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return
    if isinstance(data, dict) and data.get("resolved_at") is None:
        data["resolved_at"] = _now()
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def db_state(data_dir: Path) -> dict[str, Any]:
    """Full recovery snapshot for owner/admin diagnostics — includes report internals."""
    data = last_report(data_dir)
    if not data:
        return {"state": "ok", "report": None}
    resolved = bool(data.get("resolved_at"))
    state = "ok" if resolved else data.get("mode", "unknown")
    return {"state": state, "report": data}


def db_health_summary(data_dir: Path) -> dict[str, str]:
    """Coarse DB readiness for public /health — state only, no recovery internals."""
    return {"state": str(db_state(data_dir)["state"])}


def _quarantine(path: Path) -> Path:
    """Sposta main/wal/shm nella quarantena; ritorna la dir della copia main."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    quarantine = recovery_root(path.parent) / stamp / QUARANTINE_SUBDIR
    quarantine.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        source = Path(str(path) + suffix)
        if source.exists():
            shutil.move(str(source), str(quarantine / source.name))
    return quarantine


def _table_names(conn: sqlite3.Connection) -> list[str]:
    return [row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )]


def _copy_table(src: sqlite3.Connection, dst: sqlite3.Connection, table: str,
                report: RecoveryReport) -> None:
    """Copia riga per riga; su errore scansiona per rowid a blocchi."""
    stats = {"kept": 0, "lost": 0}
    report.tables[table] = stats

    def _insert(row: tuple) -> bool:
        placeholders = ",".join("?" * len(row))
        try:
            dst.execute(f"INSERT INTO {table} VALUES ({placeholders})", row)
            return True
        except sqlite3.Error:
            stats["lost"] += 1
            return False

    dst_tables = set(_table_names(dst))
    if table not in dst_tables:
        # tabelle create fuori da initialize (es. memories dal memory port):
        # si ricrea lo schema verbatim dalla sorgente
        row = src.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            (table,)).fetchone()
        if row is None or not row[0]:
            report.issues.append(RecoveryIssue(
                "unreadable_table", table, "schema mancante nella sorgente"))
            return
        dst.execute(row[0])

    try:
        rows = src.execute(f"SELECT * FROM {table}").fetchall()
    except sqlite3.Error as exc:
        report.issues.append(RecoveryIssue(
            "unreadable_table", table, f"SELECT completo fallito: {exc}"))
        rows = _scan_by_rowid(src, table, report)

    for row in rows:
        if _insert(row):
            stats["kept"] += 1


def _scan_by_rowid(src: sqlite3.Connection, table: str,
                   report: RecoveryReport) -> list[tuple]:
    """Ultima spiaggia: finestre di rowid, saltando le pagine morte."""
    rows: list[tuple] = []
    try:
        max_rowid = src.execute(f"SELECT max(rowid) FROM {table}").fetchone()[0] or 0
    except sqlite3.Error:
        return rows
    window = 500
    rowid = 1
    while rowid <= max_rowid:
        try:
            chunk = src.execute(
                f"SELECT * FROM {table} WHERE rowid BETWEEN ? AND ?",
                (rowid, rowid + window - 1)).fetchall()
            rows.extend(chunk)
        except sqlite3.Error as exc:
            report.issues.append(RecoveryIssue(
                "page_corruption", table,
                f"finestra rowid {rowid}-{rowid + window - 1} illeggibile: {exc}"))
        rowid += window
    return rows


def _validate_documents(path: Path, workspace_id: str,
                        report: RecoveryReport, *,
                        encryption_key: bytes | None = None) -> None:
    """Butta le righe che non validano più e riallinea i cursori di meta.

    È il caso davvero capitato: un evento con campi mancanti uccideva
    `_load()` e quindi l'intero avvio. Qui la riga viene messa da parte,
    non il database.
    """
    from homun.domain.models import CommandRecord, DomainEvent
    conn = _open_connection(path, encryption_key)
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN IMMEDIATE")
        for kind, (attr, model) in ENTITY_TYPES.items():
            invalid: list[tuple[str, str]] = []
            for row_id, payload in conn.execute(
                    "SELECT id, payload FROM entities WHERE kind=?", (kind,)).fetchall():
                try:
                    model.model_validate_json(payload)
                except Exception:
                    invalid.append((row_id, payload))
            for row_id, _payload in invalid:
                conn.execute("DELETE FROM entities WHERE id=?", (row_id,))
                report.issues.append(RecoveryIssue(
                    "row_invalid", "entities",
                    f"entità {kind} {row_id} scartata: non valida più"))
            if invalid:
                report.tables.setdefault("entities", {"kept": 0, "lost": 0})
                report.tables["entities"]["lost"] += len(invalid)
        for sequence, payload in conn.execute(
                "SELECT sequence, payload FROM events").fetchall():
            try:
                DomainEvent.model_validate_json(payload)
            except Exception:
                conn.execute("DELETE FROM events WHERE sequence=?", (sequence,))
                report.issues.append(RecoveryIssue(
                    "row_invalid", "events",
                    f"evento sequence={sequence} scartato: non valido più"))
                report.tables.setdefault("events", {"kept": 0, "lost": 0})
                report.tables["events"]["lost"] += 1
        for command_id, payload in conn.execute(
                "SELECT command_id, payload FROM commands").fetchall():
            try:
                CommandRecord.model_validate_json(payload)
            except Exception:
                conn.execute("DELETE FROM commands WHERE command_id=?", (command_id,))
                report.issues.append(RecoveryIssue(
                    "row_invalid", "commands",
                    f"comando {command_id} scartato: non valido più"))
                report.tables.setdefault("commands", {"kept": 0, "lost": 0})
                report.tables["commands"]["lost"] += 1
        # cursori di concorrenza riallineati al contenuto superstite
        row = conn.execute("SELECT COALESCE(MAX(sequence), 0) FROM events").fetchone()
        conn.execute("UPDATE meta SET value=? WHERE key='sequence'",
                     (str(int(row[0])),))
        row = conn.execute("SELECT value FROM meta WHERE key='generation'").fetchone()
        generation = int(row[0]) if row and row[0] and row[0].isdigit() else 0
        conn.execute("UPDATE meta SET value=? WHERE key='generation'",
                     (str(generation + 1),))
        conn.execute(
            "INSERT OR REPLACE INTO meta VALUES ('workspace_id', ?)", (workspace_id,))
        conn.commit()
    finally:
        conn.close()


def salvage_workspace(path: Path, workspace_id: str, *,
                      encryption_key: bytes | None = None) -> RecoveryReport:
    """Quarantena l'originale e ricostruisce un database sano in `path`.

    Se il file è del tutto illeggibile, `path` diventa un workspace nuovo
    (mode='minimal'): il motore parte comunque, i dati originali restano
    in quarantena per un intervento manuale.
    """
    report = RecoveryReport(mode="repaired", started_at=_now(), workspace_id=workspace_id)
    quarantine = _quarantine(path)
    report.quarantine_dir = str(quarantine)
    source_main = quarantine / path.name

    fresh = Path(str(path) + ".salvaged")
    for suffix in ("", "-wal", "-shm"):
        stale = Path(str(fresh) + suffix if suffix else str(fresh))
        if stale.exists():
            stale.unlink()

    try:
        src = _open_connection(source_main, encryption_key)
        try:
            dst = _open_connection(fresh)
            try:
                initialize(dst, workspace_id)
                dst.execute("PRAGMA journal_mode=WAL")
                dst.execute("PRAGMA foreign_keys=OFF")
                for table in _table_names(src):
                    if table == "meta":
                        continue  # i cursori si riallineano dopo la validazione
                    _copy_table(src, dst, table, report)
                dst.commit()
            finally:
                dst.close()
        finally:
            src.close()
        _validate_documents(fresh, workspace_id, report, encryption_key=encryption_key)
        # verifica finale: il ricostruito deve caricarsi davvero
        from homun.storage.sqlite import SqliteWorkspaceRepository
        probe = SqliteWorkspaceRepository(fresh, workspace_id, encryption_key=encryption_key)
        try:
            probe.load()
        finally:
            probe.close()
        shutil.move(str(fresh), str(path))
    except Exception as exc:
        report.mode = "minimal"
        report.issues.append(RecoveryIssue(
            "unreadable_database", None, f"salvage non riuscito: {exc}"))
        for suffix in ("", "-wal", "-shm"):
            victim = Path(str(path) + suffix)
            if victim.exists():
                victim.unlink()
        if fresh.exists():
            fresh.unlink()
        initialize_fresh(path, workspace_id)

    report.finished_at = _now()
    return report


def initialize_fresh(path: Path, workspace_id: str) -> None:
    """Crea un workspace nuovo minimale al posto del corrotto."""
    conn = _open_connection(path)
    try:
        initialize(conn, workspace_id)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.commit()
    finally:
        conn.close()
