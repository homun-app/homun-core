"""Named search providers and one-shot rescue.

Homun does not invent results and refuses private addresses. Credential-requiring
providers require explicit keys in the environment.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from homun.execution.web_cache import GLOBAL_WEB_CACHE
from homun.execution.web_pages import PageRefusal, _classify, search_public

_PROVIDER_ENV_KEYS: dict[str, str] = {
    "brave": "BRAVE_API_KEY",
    "tavily": "TAVILY_API_KEY",
    "exa": "EXA_API_KEY",
    "firecrawl": "FIRECRAWL_API_KEY",
    "perplexity": "PERPLEXITY_API_KEY",
    "xai": "XAI_API_KEY",
}


def _call_brave(query: str, api_key: str, limit: int = 5) -> dict:
    url = f"https://api.search.brave.com/res/v1/web/search?q={urllib.parse.quote(query)}&count={limit}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "X-Subscription-Token": api_key})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            for item in (data.get("web") or {}).get("results") or []:
                link = str(item.get("url") or "")
                try:
                    _classify(link)
                except PageRefusal:
                    continue
                results.append({
                    "url": link,
                    "title": str(item.get("title") or "")[:200],
                    "snippet": str(item.get("description") or "")[:300],
                })
                if len(results) >= limit:
                    break
            return {"provider": "brave", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Brave search failed: {exc}"}


def _call_tavily(query: str, api_key: str, limit: int = 5) -> dict:
    url = "https://api.tavily.com/search"
    payload = json.dumps({"query": query, "max_results": limit}).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            for item in data.get("results") or []:
                link = str(item.get("url") or "")
                try:
                    _classify(link)
                except PageRefusal:
                    continue
                results.append({
                    "url": link,
                    "title": str(item.get("title") or "")[:200],
                    "snippet": str(item.get("content") or "")[:300],
                })
                if len(results) >= limit:
                    break
            return {"provider": "tavily", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Tavily search failed: {exc}"}


def execute_provider_search(provider_name: str, query: str, limit: int = 5) -> dict:
    name = (provider_name or "").strip().lower()
    if name in {"duckduckgo-html", "duckduckgo", "default"}:
        return search_public(query)
    if name not in _PROVIDER_ENV_KEYS:
        return {
            "error_code": "web_provider_unavailable",
            "message": f"Unknown search provider: {name}. Supported: duckduckgo-html, {', '.join(sorted(_PROVIDER_ENV_KEYS))}",
        }
    env_var = _PROVIDER_ENV_KEYS[name]
    api_key = os.environ.get(env_var, "").strip()
    if not api_key:
        return {
            "error_code": "web_provider_credentials_missing",
            "message": f"No API key configured for provider '{name}'. Set {env_var}.",
        }
    if name == "brave":
        return _call_brave(query, api_key, limit)
    if name == "tavily":
        return _call_tavily(query, api_key, limit)
    return {
        "error_code": "web_provider_unavailable",
        "message": f"Provider '{name}' is configured with credentials but live adapter is not yet connected.",
    }


def search_with_rescue(
    query: str,
    provider: str | None = None,
    limit: int = 5,
    enable_rescue: bool = True,
    cache=None,
) -> dict:
    """Execute search with TTL caching and one-shot fallback rescue if primary fails."""
    if not isinstance(query, str) or not query.strip() or len(query) > 500 or "\n" in query or "\r" in query:
        return {"error_code": "web_query_refused", "message": "The search query is empty or not a single line"}
    prov = (provider or "duckduckgo-html").strip().lower()
    c = cache or GLOBAL_WEB_CACHE
    hit = c.get_search(prov, query)
    if hit is not None:
        return {**hit, "cached": True}

    res = execute_provider_search(prov, query, limit=limit)
    if "error_code" not in res:
        c.put_search(prov, query, res)
        return res

    # If policy refusal (e.g. query format), do not rescue
    if res.get("error_code") == "web_query_refused":
        return res

    if enable_rescue and prov not in {"duckduckgo-html", "duckduckgo", "default"}:
        orig_err = res.get("message") or res.get("error_code")
        fallback = search_public(query)
        if "error_code" not in fallback:
            return {
                **fallback,
                "rescued_from": prov,
                "backend_error": (
                    f"Configured backend '{prov}' failed this call ({orig_err}); "
                    "result served by public fallback."
                ),
            }
    return res
