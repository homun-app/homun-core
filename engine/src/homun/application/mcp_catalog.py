"""Curated MCP catalog: vetted declarations, reviewed in this repository.

Presence here means vetting, not installation: every entry stays inert until
the person declares it, and the command/source is always visible up front
(the Hermes rule — read the manifest before you run anything).
"""
from __future__ import annotations
from typing import Any

MCP_CATALOG: list[dict[str, Any]] = [
    {
        "id": "filesystem",
        "name": "File del progetto (filesystem)",
        "description": "Legge i file di una cartella che scegli tu. La cartella va indicata alla dichiarazione.",
        "transport": "stdio",
        "command": "npx",
        "args_prefix": ["-y", "@modelcontextprotocol/server-filesystem"],
        "needs_path": "Cartella a cui dare accesso",
        "path_flag": None,  # positional: the path goes last
        "tools_include": ["read_file", "list_directory", "search_files", "get_file_info"],
        "source": "npm: @modelcontextprotocol/server-filesystem",
        "notes": "Dichiara una cartella per volta; l'agente vede solo quella.",
    },
    {
        "id": "git",
        "name": "Repository Git",
        "description": "Stato, log e diff di un repository locale che scegli tu.",
        "transport": "stdio",
        "command": "uvx",
        "args_prefix": ["mcp-server-git", "--repository"],
        "needs_path": "Percorso del repository",
        "path_flag": "value",  # --repository <path>
        "tools_include": ["git_status", "git_log", "git_diff_unstaged", "git_diff_staged"],
        "source": "pypi: mcp-server-git",
        "notes": "Sola lettura: nessun commit o push.",
    },
    {
        "id": "fetch",
        "name": "Pagine e documentazione (fetch)",
        "description": "Scarica pagine web e documentazione online su richiesta.",
        "transport": "stdio",
        "command": "uvx",
        "args_prefix": ["mcp-server-fetch"],
        "needs_path": None,
        "path_flag": None,
        "tools_include": ["fetch"],
        "source": "pypi: mcp-server-fetch",
        "notes": "Solo lettura pubblica; nessuna chiave richiesta.",
    },
    {
        "id": "sqlite",
        "name": "Database SQLite",
        "description": "Interroga un file SQLite locale (in sola lettura consigliata).",
        "transport": "stdio",
        "command": "uvx",
        "args_prefix": ["mcp-server-sqlite", "--db-path"],
        "needs_path": "Percorso del file .sqlite",
        "path_flag": "value",
        "tools_include": ["list_tables", "read_query", "describe_table"],
        "tools_exclude": ["write_query"],
        "source": "pypi: mcp-server-sqlite",
        "notes": "write_query escluso: prima dichiara, poi allarga se serve davvero.",
    },
    {
        "id": "memory",
        "name": "Grafo di note (memory)",
        "description": "Note strutturate come grafo di entità e relazioni.",
        "transport": "stdio",
        "command": "npx",
        "args_prefix": ["-y", "@modelcontextprotocol/server-memory"],
        "needs_path": None,
        "path_flag": None,
        "tools_include": ["create_entities", "add_observations", "search_nodes", "read_graph"],
        "source": "npm: @modelcontextprotocol/server-memory",
        "notes": "Dati locali al browser del server; nessuna chiave.",
    },
]


def catalog_public() -> list[dict[str, Any]]:
    """The catalog as shown to the person: everything visible, nothing hidden."""
    return [
        {
            "id": entry["id"], "name": entry["name"], "description": entry["description"],
            "transport": entry["transport"], "command": entry["command"],
            "args_prefix": entry["args_prefix"], "needs_path": entry["needs_path"],
            "tools_include": entry.get("tools_include", []),
            "tools_exclude": entry.get("tools_exclude", []),
            "source": entry["source"], "notes": entry["notes"],
        }
        for entry in MCP_CATALOG
    ]
