# Graphify code-graph sidecar — invisible infrastructure for "the project map".
# A ONE-SHOT container: mount a project read-only, build its knowledge graph with
# tree-sitter (no LLM, no network at run time), emit graph.json to a mounted out dir.
# The user never installs Python/Graphify; the gateway runs this on demand.
FROM python:3.12-slim

# rsync: copy the read-only project into a writable workdir excluding heavy trees
# (Graphify writes graphify-out/ in-tree, so it needs a writable copy — and we keep
# the user's real repo untouched: nothing is written back to the mounted source).
RUN apt-get update \
    && apt-get install -y --no-install-recommends rsync \
    && rm -rf /var/lib/apt/lists/*

# graphifyy bundles the tree-sitter grammars; code extraction is fully local.
RUN pip install --no-cache-dir graphifyy

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
