-- Knowledge namespaces: security-scoped access control for RAG and memory.
-- Default _private: only the owner can see. Must explicitly open via perimeter.
-- Reserved: _public (all contacts), _private (owner only), _profile:{slug} (profile-scoped).

ALTER TABLE rag_sources ADD COLUMN namespace TEXT NOT NULL DEFAULT '_private';
ALTER TABLE memory_chunks ADD COLUMN namespace TEXT NOT NULL DEFAULT '_private';

CREATE INDEX IF NOT EXISTS idx_rag_sources_namespace ON rag_sources(namespace);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_namespace ON memory_chunks(namespace);

-- Backfill: existing data that has no profile scoping becomes _private (owner-only).
-- Data already scoped to a profile stays _private but could be opened later.
-- This is intentionally conservative: deny by default.
