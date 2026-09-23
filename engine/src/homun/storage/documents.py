"""Domain document codecs and bounded row updates."""
from homun.domain import models

ENTITY_TYPES = {
    "agent": ("agents", models.AgentProfile),
    "team": ("teams", models.Team),
    "grant": ("grants", models.AccessGrant),
    "material": ("materials", models.MaterialVersion),
    "project": ("projects", models.Project),
    "conversation": ("conversations", models.Conversation),
    "message": ("messages", models.Message),
    "work": ("works", models.Work),
    "runtime_intent": ("outbox", models.RuntimeIntent),
    "run": ("runs", models.Run),
    "plan": ("plans", models.PlanRevision),
    "contribution": ("contributions", models.ContributionRequest),
    "artifact": ("artifacts", models.ArtifactVersion),
    "review": ("reviews", models.Review),
    "work_budget": ("work_budgets", models.WorkBudget),
    "routine": ("routines", models.Routine),
    "external_server": ("external_servers", models.ExternalServer),
    "skill": ("skills", models.Skill),
}


def write_delta(conn, table, keys, desired):
    """Only touch changed or removed rows; identifiers are internal constants."""
    current = {tuple(row[:-1]): row[-1] for row in conn.execute(
        f"SELECT {', '.join(keys)}, payload FROM {table}"
    )}
    where = " AND ".join(f"{key}=?" for key in keys)
    for key in current.keys() - desired.keys():
        conn.execute(f"DELETE FROM {table} WHERE {where}", key)
    for key, payload in desired.items():
        if key not in current:
            placeholders = ', '.join('?' for _ in range(len(keys) + 1))
            conn.execute(f"INSERT INTO {table} ({', '.join(keys)}, payload) VALUES ({placeholders})", (*key, payload))
        elif current[key] != payload:
            conn.execute(f"UPDATE {table} SET payload=? WHERE {where}", (payload, *key))
    return current != desired
