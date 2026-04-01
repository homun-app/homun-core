#!/usr/bin/env python3
"""Battery test: plan-first cognition with kimi-k2.5.
Tests 15 diverse scenarios to verify plan_execution is always called."""

import json
import urllib.request
import time

OLLAMA_URL = "http://localhost:11434/v1/chat/completions"
MODEL = "kimi-k2.5:cloud"

SYSTEM_PROMPT = """You are the planning module of Homun, a personal AI assistant.
Analyze the user request and call plan_execution with your analysis.

Available tools you can reference in your plan:
- browser: Navigate websites, fill forms, click elements, extract data
- web_search: Search the web (Brave Search)
- web_fetch: Fetch a URL content
- shell: Execute shell commands
- remember: Save user preferences to memory
- send_message: Reply to the user
- read_file / write_file / edit_file / list_dir: File operations
- knowledge: Search user documents (RAG knowledge base)
- contacts: Manage contacts
- vault: Manage encrypted secrets
- automation: Create/manage automations
- workflow: Multi-step workflow orchestration
- spawn_subagent: Run background tasks
- cron: Schedule recurring tasks
- read_email_inbox: Read emails (IMAP)
- create_skill: Generate new agent skills

Current time: 2026-03-28 15:30 (Saturday)
Current year: 2026

Classify intent_type:
- informational: find/compare/research data. Output = present info to user
- transactional: complete an action (book, buy, send, register). Output = action done
- navigational: go to a specific site or page
- creative: write, generate, or transform content

Write specific actionable plan steps.
Extract ALL concrete parameters into constraints (dates, locations, quantities, preferences)."""

TOOL_DEF = {
    "type": "function",
    "function": {
        "name": "plan_execution",
        "description": "Submit your analysis of the user request.",
        "parameters": {
            "type": "object",
            "properties": {
                "understanding": {"type": "string"},
                "complexity": {"type": "string", "enum": ["simple", "standard", "complex"]},
                "answer_directly": {"type": "boolean"},
                "intent_type": {"type": "string", "enum": ["informational", "transactional", "navigational", "creative"]},
                "success_criteria": {"type": "string"},
                "tools": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "reason": {"type": "string"}}, "required": ["name"]}},
                "plan": {"type": "array", "items": {"type": "string"}},
                "constraints": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["understanding", "complexity", "answer_directly", "intent_type", "success_criteria"]
        }
    }
}

TESTS = [
    ("Browser booking (IT)", "mi trovi un treno da napoli a venezia per il 20 settembre"),
    ("Simple greeting", "ciao come stai?"),
    ("Web search (EN)", "what is the current price of Bitcoin?"),
    ("File operation", "leggi il file config.toml e dimmi quali canali sono configurati"),
    ("Creative writing", "scrivimi una poesia sulla primavera in napoletano"),
    ("Multi-step transactional", "prenota un tavolo per 4 persone a cena domani sera a Roma, budget 50 euro a testa"),
    ("Knowledge search", "cerca nei miei documenti le specifiche del progetto Alpha"),
    ("Shell command", "quant'e' grande la cartella /tmp?"),
    ("Email reading", "controlla se ho ricevuto email da Marco oggi"),
    ("Remember preference", "ricorda che la mia stazione preferita e' Napoli Centrale e viaggio sempre in seconda classe"),
    ("Price comparison", "confronta i prezzi dei voli Roma-Londra per il 15 aprile su Ryanair e EasyJet"),
    ("Scheduled task", "ogni mattina alle 8 controllami le email e mandami un riassunto su Telegram"),
    ("Ambiguous request", "puoi aiutarmi con una cosa?"),
    ("Technical question", "qual e' la differenza tra TCP e UDP?"),
    ("Mixed language", "find me the best pizza restaurant near Piazza Navona, check reviews on TripAdvisor"),
]


def run_test(num, label, prompt):
    body = json.dumps({
        "model": MODEL,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "tools": [TOOL_DEF],
    }).encode()

    req = urllib.request.Request(OLLAMA_URL, data=body, headers={"Content-Type": "application/json"})
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        elapsed = time.time() - start
        print(f"[{num:02d}] \u274c {label} \u2014 ERROR: {e} ({elapsed:.1f}s)")
        return False

    elapsed = time.time() - start
    msg = data["choices"][0]["message"]
    tokens = data.get("usage", {}).get("total_tokens", "?")

    if msg.get("tool_calls"):
        tc = msg["tool_calls"][0]
        raw = tc["function"]["arguments"]
        args = json.loads(raw) if isinstance(raw, str) else raw

        raw_tools = args.get("tools", [])
        tools = [t.get("name", "?") if isinstance(t, dict) else str(t) for t in raw_tools]
        intent = args.get("intent_type", "?")
        direct = args.get("answer_directly", False)
        plan_steps = len(args.get("plan", []))
        constraint_count = len(args.get("constraints", []))
        complexity = args.get("complexity", "?")

        print(f"[{num:02d}] \u2705 {label} ({elapsed:.1f}s, {tokens} tok)")
        print(f"     intent={intent} complexity={complexity} direct={direct}")
        print(f"     tools={tools} plan={plan_steps} steps, {constraint_count} constraints")
        return True
    else:
        content = (msg.get("content") or "")[:150]
        print(f"[{num:02d}] \u274c {label} \u2014 NO tool_call ({elapsed:.1f}s, {tokens} tok)")
        print(f"     content: {content}")
        return False


def main():
    print("=" * 65)
    print(f" Plan-First Cognition Battery Test \u2014 {MODEL}")
    print("=" * 65)
    print()

    passed = 0
    total = len(TESTS)

    for i, (label, prompt) in enumerate(TESTS, 1):
        if run_test(i, label, prompt):
            passed += 1

    print()
    print("=" * 65)
    pct = (passed / total * 100) if total else 0
    status = "\u2705" if passed == total else "\u26a0\ufe0f"
    print(f" {status} Results: {passed}/{total} passed ({pct:.0f}%)")
    print("=" * 65)


if __name__ == "__main__":
    main()
