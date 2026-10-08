"""Named search providers and one-shot rescue.

Homun does not invent results and refuses private addresses. Credential-requiring
providers require explicit keys in the environment.
"""
from __future__ import annotations

import json
import os
import re
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
    "parallel": "PARALLEL_API_KEY",
    "keenable": "KEENABLE_API_KEY",
}


def _safe_hit(link: str, title: str = "", snippet: str = "") -> dict | None:
    target = str(link or "").strip()
    if not target:
        return None
    try:
        _classify(target)
    except PageRefusal:
        return None
    return {
        "url": target,
        "title": str(title or "")[:200],
        "snippet": str(snippet or "")[:300],
    }


def _call_brave(query: str, api_key: str, limit: int = 5) -> dict:
    url = f"https://api.search.brave.com/res/v1/web/search?q={urllib.parse.quote(query)}&count={limit}"
    req = urllib.request.Request(url, headers={"Accept": "application/json", "X-Subscription-Token": api_key})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            for item in (data.get("web") or {}).get("results") or []:
                hit = _safe_hit(item.get("url"), item.get("title"), item.get("description"))
                if hit:
                    results.append(hit)
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
                hit = _safe_hit(item.get("url"), item.get("title"), item.get("content"))
                if hit:
                    results.append(hit)
                if len(results) >= limit:
                    break
            return {"provider": "tavily", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Tavily search failed: {exc}"}


def _call_exa(query: str, api_key: str, limit: int = 5) -> dict:
    url = "https://api.exa.ai/search"
    payload = json.dumps({"query": query, "numResults": limit}).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "x-api-key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            for item in data.get("results") or []:
                hit = _safe_hit(item.get("url"), item.get("title"), item.get("text") or item.get("snippet"))
                if hit:
                    results.append(hit)
                if len(results) >= limit:
                    break
            return {"provider": "exa", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Exa search failed: {exc}"}


def _call_firecrawl(query: str, api_key: str, limit: int = 5) -> dict:
    url = "https://api.firecrawl.dev/v1/search"
    payload = json.dumps({"query": query, "limit": limit}).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            raw_items = data.get("data") if isinstance(data.get("data"), list) else (data.get("results") or [])
            for item in raw_items:
                hit = _safe_hit(item.get("url"), item.get("title"), item.get("description") or item.get("content"))
                if hit:
                    results.append(hit)
                if len(results) >= limit:
                    break
            return {"provider": "firecrawl", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Firecrawl search failed: {exc}"}


def _call_searxng(query: str, base_url: str, limit: int = 5) -> dict:
    url = f"{base_url.rstrip('/')}/search?q={urllib.parse.quote(query)}&format=json"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            for item in data.get("results") or []:
                hit = _safe_hit(item.get("url"), item.get("title"), item.get("content"))
                if hit:
                    results.append(hit)
                if len(results) >= limit:
                    break
            return {"provider": "searxng", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"SearXNG search failed: {exc}"}


def _call_perplexity(query: str, api_key: str, limit: int = 5, base_url: str | None = None) -> dict:
    root = (base_url or os.environ.get("PERPLEXITY_BASE_URL") or "https://api.perplexity.ai").rstrip("/")
    url = f"{root}/search"
    payload = json.dumps({
        "query": query, "max_results": max(1, min(limit, 20)), "search_context_size": "low",
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            for item in data.get("results") or []:
                hit = _safe_hit(item.get("url"), item.get("title"), item.get("snippet") or item.get("description"))
                if hit:
                    results.append(hit)
                if len(results) >= limit:
                    break
            if not results and data.get("citations"):
                for cite in data.get("citations"):
                    link = cite if isinstance(cite, str) else str(cite.get("url") or "")
                    title = str(cite.get("title") or "") if isinstance(cite, dict) else ""
                    snip = str(cite.get("snippet") or "") if isinstance(cite, dict) else ""
                    hit = _safe_hit(link, title, snip)
                    if hit:
                        results.append(hit)
                    if len(results) >= limit:
                        break
            return {"provider": "perplexity", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Perplexity search failed: {exc}"}


def _call_xai(query: str, api_key: str, limit: int = 5, base_url: str | None = None) -> dict:
    root = (base_url or os.environ.get("XAI_BASE_URL") or "https://api.x.ai/v1").rstrip("/")
    url = f"{root}/responses"
    prompt = (
        f"Search the web for: {query}. Return ONLY a JSON object with a 'results' array "
        f"where each element has 'url', 'title', and 'snippet'. Maximum {limit} results."
    )
    payload = json.dumps({
        "model": os.environ.get("XAI_WEB_MODEL", "grok-build-0.1"),
        "input": [{"role": "user", "content": prompt}],
        "tools": [{"type": "web_search"}],
        "include": ["no_inline_citations"],
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("error"):
                return {"error_code": "web_fetch_failed", "message": f"xAI search failed: {data['error']}"}

            results = []
            text = ""
            for choice in (data.get("output") or data.get("choices") or []):
                msg = choice.get("message") if isinstance(choice, dict) else choice
                if isinstance(msg, dict):
                    content = msg.get("content") or ""
                    if isinstance(content, str):
                        text += content

            json_match = re.search(r"\{[\s\S]*\}", text)
            if json_match:
                try:
                    parsed = json.loads(json_match.group(0))
                    for item in (parsed.get("results") or []):
                        hit = _safe_hit(item.get("url"), item.get("title"), item.get("snippet") or item.get("description"))
                        if hit:
                            results.append(hit)
                        if len(results) >= limit:
                            break
                except Exception:
                    pass

            if not results:
                for cite in (data.get("citations") or []):
                    hit = _safe_hit(cite.get("url"), cite.get("title"), cite.get("snippet") or cite.get("text"))
                    if hit:
                        results.append(hit)
                    if len(results) >= limit:
                        break

            return {"provider": "xai", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"xAI search failed: {exc}"}


def _call_parallel(query: str, api_key: str, limit: int = 5, base_url: str | None = None) -> dict:
    root = (base_url or os.environ.get("PARALLEL_BASE_URL") or "https://api.parallel.ai").rstrip("/")
    url = f"{root}/v1beta/search"
    payload = json.dumps({
        "search_queries": [query], "objective": query,
        "mode": os.environ.get("PARALLEL_SEARCH_MODE", "agentic"),
        "max_results": limit,
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            for item in data.get("results") or []:
                snip = " ".join(item.get("excerpts") or []) if isinstance(item.get("excerpts"), list) else str(item.get("snippet") or "")
                hit = _safe_hit(item.get("url"), item.get("title"), snip)
                if hit:
                    results.append(hit)
                if len(results) >= limit:
                    break
            return {"provider": "parallel", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Parallel search failed: {exc}"}


def _call_keenable(query: str, api_key: str | None = None, limit: int = 5, base_url: str | None = None) -> dict:
    root = (base_url or os.environ.get("KEENABLE_BASE_URL") or "https://api.keenable.ai").rstrip("/")
    url = f"{root}/v1/search"
    payload = json.dumps({"query": query, "max_results": limit}).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-Keenable-Title": "homun-engine"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=payload, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            results = []
            for item in data.get("results") or []:
                hit = _safe_hit(item.get("url"), item.get("title"), item.get("snippet") or item.get("description"))
                if hit:
                    results.append(hit)
                if len(results) >= limit:
                    break
            return {"provider": "keenable", "query": query, "results": results}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Keenable search failed: {exc}"}


def _call_parallel_extract(url: str, api_key: str, base_url: str | None = None) -> dict:
    root = (base_url or os.environ.get("PARALLEL_BASE_URL") or "https://api.parallel.ai").rstrip("/")
    target = f"{root}/v1beta/extract"
    payload = json.dumps({"urls": [url], "full_content": True}).encode("utf-8")
    req = urllib.request.Request(
        target, data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for item in data.get("results") or []:
                content = str(item.get("full_content") or item.get("text") or "")
                return {"status": 200, "url": url, "text": content[:16000], "truncated": len(content) > 16000}
            return {"error_code": "web_fetch_failed", "message": "Parallel extract returned no content"}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Parallel extract failed: {exc}"}


def _call_keenable_extract(url: str, api_key: str | None = None, base_url: str | None = None) -> dict:
    root = (base_url or os.environ.get("KEENABLE_BASE_URL") or "https://api.keenable.ai").rstrip("/")
    target = f"{root}/v1/fetch?url={urllib.parse.quote(url)}"
    headers = {"Accept": "application/json", "X-Keenable-Title": "homun-engine"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(target, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            content = str(data.get("content") or data.get("text") or "")
            return {"status": 200, "url": url, "text": content[:16000], "truncated": len(content) > 16000}
    except Exception as exc:
        return {"error_code": "web_fetch_failed", "message": f"Keenable extract failed: {exc}"}


def execute_provider_search(provider_name: str, query: str, limit: int = 5) -> dict:
    name = (provider_name or "").strip().lower()
    if name in {"duckduckgo-html", "duckduckgo", "default"}:
        return search_public(query)
    if name in {"openai-native", "openai_native"}:
        return {
            "error_code": "web_provider_unsupported",
            "message": "openai-native declares OpenAI's server-side web_search tool; it cannot run as a client-side search and requires the Codex Responses transport.",
        }
    if name == "searxng":
        url = os.environ.get("SEARXNG_URL", "").strip()
        if not url:
            return {
                "error_code": "web_provider_credentials_missing",
                "message": "No instance URL configured for SearXNG. Set SEARXNG_URL.",
            }
        return _call_searxng(query, url, limit)
    if name not in _PROVIDER_ENV_KEYS:
        return {
            "error_code": "web_provider_unavailable",
            "message": f"Unknown search provider: {name}. Supported: duckduckgo-html, searxng, openai-native, {', '.join(sorted(_PROVIDER_ENV_KEYS))}",
        }
    env_var = _PROVIDER_ENV_KEYS[name]
    api_key = os.environ.get(env_var, "").strip()
    if not api_key and name != "keenable":
        return {
            "error_code": "web_provider_credentials_missing",
            "message": f"STOP trying providers: no API key for provider '{name}'. Set {env_var}.",
        }
    if name == "brave":
        return _call_brave(query, api_key, limit)
    if name == "tavily":
        return _call_tavily(query, api_key, limit)
    if name == "exa":
        return _call_exa(query, api_key, limit)
    if name == "firecrawl":
        return _call_firecrawl(query, api_key, limit)
    if name == "perplexity":
        return _call_perplexity(query, api_key, limit)
    if name == "xai":
        return _call_xai(query, api_key, limit)
    if name == "parallel":
        return _call_parallel(query, api_key, limit)
    if name == "keenable":
        return _call_keenable(query, api_key or None, limit)
    return {
        "error_code": "web_provider_unavailable",
        "message": f"Provider '{name}' is configured with credentials but live adapter is not yet connected.",
    }


def execute_provider_extract(url: str, provider: str | None = None) -> dict:
    name = (provider or "").strip().lower()
    if name == "parallel":
        api_key = os.environ.get("PARALLEL_API_KEY", "").strip()
        if not api_key:
            return {"error_code": "web_provider_credentials_missing", "message": "PARALLEL_API_KEY is not configured."}
        return _call_parallel_extract(url, api_key)
    if name == "keenable":
        api_key = os.environ.get("KEENABLE_API_KEY", "").strip() or None
        return _call_keenable_extract(url, api_key)
    if name in {"", "direct", "native", "default", "fetch_page"}:
        from homun.execution.web_pages import fetch_page
        return fetch_page(url)
    return {
        "error_code": "web_provider_unsupported",
        "message": f"Web extraction is not supported by provider '{provider}'. Supported extract backends: parallel, keenable, or default/direct.",
    }


def search_with_rescue(
    query: str,
    provider: str | None = None,
    limit: int = 5,
    cache=None,
) -> dict:
    actual_cache = cache if cache is not None else GLOBAL_WEB_CACHE
    backend = (provider or "duckduckgo-html").strip().lower()

    if actual_cache is not None:
        cached = actual_cache.get_search(backend, query)
        if cached:
            return {**cached, "cached": True}

    res = execute_provider_search(backend, query, limit)
    if not res.get("error_code"):
        if actual_cache is not None:
            actual_cache.put_search(backend, query, res)
        return res

    fallback = search_public(query)
    if fallback.get("error_code"):
        return res

    return {
        **fallback,
        "rescued_from": backend,
        "backend_error": f"Configured backend '{backend}' failed with {res.get('error_code')}: {res.get('message')}. Served via public fallback.",
    }
