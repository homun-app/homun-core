# Architettura — quadro d'insieme

> Diagramma vivo (aggiornato 2026-06-22). Sostituisce il vecchio poster SVG
> (`Desktop/homun-architecture.svg`, datato: MLX/Gemma-fallback, loop non
> cross-modello). Dettagli: [agent-loop](agent-loop.md) · [memory](memory.md) ·
> [plugins](plugins.md) · [system-map](system-map.md). Un poster SVG rifinito si
> rigenera su richiesta.

```mermaid
flowchart TD
  subgraph SURF[Superfici & Canali · client su HTTP]
    APP[App desktop · Electron + React]
    CH[Canali · WhatsApp wa-rs · Telegram]
  end
  subgraph MOD[Modelli · Provider Registry + Ruoli · capable-first]
    R[ruoli: orchestrator · browser · memory · coding · image]
    P[provider OpenAI-compat:<br/>Ollama locale/cloud · GLM · Kimi · DeepSeek · …]
  end
  SURF --> GW
  MOD --> GW
  GW[Desktop Gateway · Rust · 127.0.0.1<br/>token 0600 + CORS + read-model redatti + lifecycle sidecar]
  GW --> ENG[Agent engine cross-modello · ADR 0016<br/>recall → plan → act → verify → advance · output IMPOSTO]
  ENG --> CAP[Tool / Capability<br/>browser · sandbox · skills · MCP/Composio · artifacts · make_deck]
  ENG --> MEM[Memoria 3 livelli<br/>SQL + grafo + markdown · local-first]
  ENG --> TASK[Durable Task Runtime<br/>queue · checkpoint · scheduler/proattività]
  GW --> SAFE[Approval & Safety<br/>browser_safety · tool policy read-only · approval gate]
  CAP --> SIDE[Sidecar<br/>browser-automation · canali · Contained Computer]
  ENG -.direzione.-> ADDON[Ecosistema Addon · ADR 0011<br/>Process Skill · contratto personalizzazione]
  GW -.opzionale.-> CLOUD[Cloud always-on<br/>single-tenant / self-hostable · NON SaaS]
```

## Bande (cosa fa ciascuna)

- **Superfici & Canali**: client su HTTP verso il gateway; canali offline-resilient.
- **Modelli**: registry + **ruoli** (binding auto/esplicito), qualunque API
  OpenAI-compatibile; **local-first** (daemon Ollama) e cloud come *scelta*.
- **Gateway** (Rust, loopback): sicurezza (token, CORS, read-model redatti), spawn +
  lifecycle dei sidecar.
- **Agent engine** ([agent-loop](agent-loop.md)): il motore cross-modello — uno solo,
  condiviso da chat/canali/automazioni.
- **Capability / Tool** ([plugins](plugins.md)): cosa l'agente può fare.
- **Memoria** ([memory](memory.md)): il differenziatore, 3 livelli.
- **Task Runtime · Safety · Sidecar · Addon · Cloud**: esecuzione durevole, governo,
  contenimento, estensibilità, always-on opzionale.
