#!/bin/bash
# Battery test: plan-first cognition with kimi-k2.5
# Tests 15 diverse scenarios to verify plan_execution is always called

OLLAMA_URL="http://localhost:11434/v1/chat/completions"
MODEL="kimi-k2.5:cloud"

SYSTEM_PROMPT='You are the planning module of Homun, a personal AI assistant.
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
Extract ALL concrete parameters into constraints (dates, locations, quantities, preferences).'

TOOL_DEF='{
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
}'

PASS=0
FAIL=0
TOTAL=0

run_test() {
    local test_num="$1"
    local label="$2"
    local prompt="$3"
    TOTAL=$((TOTAL + 1))

    local result
    result=$(curl -s --max-time 120 "$OLLAMA_URL" \
      -H "Content-Type: application/json" \
      -d "$(python3 -c "
import json
print(json.dumps({
    'model': '$MODEL',
    'temperature': 0.2,
    'messages': [
        {'role': 'system', 'content': '''$SYSTEM_PROMPT'''},
        {'role': 'user', 'content': '''$prompt'''}
    ],
    'tools': [json.loads('''$TOOL_DEF''')]
}))
")" 2>/dev/null)

    if [ -z "$result" ]; then
        echo "[$test_num] ❌ $label — NO RESPONSE (timeout or connection error)"
        FAIL=$((FAIL + 1))
        return
    fi

    python3 -c "
import json, sys
try:
    r = json.loads('''$(echo "$result" | sed "s/'/\\\\'/g")''')
except:
    r = $result

msg = r.get('choices', [{}])[0].get('message', {})
tokens = r.get('usage', {}).get('total_tokens', '?')

if msg.get('tool_calls'):
    tc = msg['tool_calls'][0]
    raw = tc['function']['arguments']
    args = json.loads(raw) if isinstance(raw, str) else raw
    tools = [t.get('name','?') for t in args.get('tools', [])]
    intent = args.get('intent_type', '?')
    direct = args.get('answer_directly', False)
    plan_count = len(args.get('plan', []))
    constraint_count = len(args.get('constraints', []))
    complexity = args.get('complexity', '?')

    status = '✅' if not direct or args.get('direct_answer') else '✅'
    print(f'[$test_num] {status} $label')
    print(f'     intent={intent} complexity={complexity} direct={direct} tools={tools}')
    print(f'     plan_steps={plan_count} constraints={constraint_count} tokens={tokens}')
    sys.exit(0)
else:
    content = msg.get('content', '')[:150]
    print(f'[$test_num] ❌ $label — NO tool_call')
    print(f'     content: {content}')
    sys.exit(1)
" 2>/dev/null

    if [ $? -eq 0 ]; then
        PASS=$((PASS + 1))
    else
        FAIL=$((FAIL + 1))
    fi
}

echo "═══════════════════════════════════════════════════════════════"
echo " Plan-First Cognition Battery Test — $MODEL"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# 1. Browser booking (the original failing case)
run_test "01" "Browser booking (IT)" \
    "mi trovi un treno da napoli a venezia per il 20 settembre"

# 2. Simple greeting
run_test "02" "Simple greeting" \
    "ciao come stai?"

# 3. Web search
run_test "03" "Web search (EN)" \
    "what is the current price of Bitcoin?"

# 4. File operation
run_test "04" "File operation" \
    "leggi il file config.toml e dimmi quali canali sono configurati"

# 5. Creative writing
run_test "05" "Creative writing (IT)" \
    "scrivimi una poesia sulla primavera in napoletano"

# 6. Multi-step transactional
run_test "06" "Multi-step transactional" \
    "prenota un tavolo per 4 persone a cena domani sera a Roma, budget 50 euro a testa"

# 7. Knowledge/RAG search
run_test "07" "Knowledge search" \
    "cerca nei miei documenti le specifiche del progetto Alpha"

# 8. Shell command
run_test "08" "Shell command" \
    "quant è grande la cartella /tmp?"

# 9. Email
run_test "09" "Email reading" \
    "controlla se ho ricevuto email da Marco oggi"

# 10. Remember preference
run_test "10" "Remember preference" \
    "ricorda che la mia stazione preferita è Napoli Centrale e viaggio sempre in seconda classe"

# 11. Complex comparison (browser)
run_test "11" "Price comparison" \
    "confronta i prezzi dei voli Roma-Londra per il 15 aprile su Ryanair e EasyJet"

# 12. Automation/cron
run_test "12" "Scheduled task" \
    "ogni mattina alle 8 controllami le email e mandami un riassunto su Telegram"

# 13. Ambiguous/conversational
run_test "13" "Ambiguous request" \
    "puoi aiutarmi con una cosa?"

# 14. Technical question (no tools needed)
run_test "14" "Technical question" \
    "qual è la differenza tra TCP e UDP?"

# 15. Multi-language mixed
run_test "15" "Mixed language" \
    "find me the best pizza restaurant near Piazza Navona, check reviews on TripAdvisor"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Results: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════════"
