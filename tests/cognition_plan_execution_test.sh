#!/bin/bash
# Test: Does kimi-k2.5:cloud call plan_execution as a tool?
#
# Test 1: ONLY plan_execution tool, simple prompt
# Test 2: plan_execution with simplified schema (fewer required fields)
# Test 3: All 6 cognition tools (discovery + plan_execution)

OLLAMA_URL="http://localhost:11434/v1/chat/completions"
MODEL="kimi-k2.5:cloud"

echo "=== TEST 1: plan_execution ONLY, simple prompt ==="
curl -s "$OLLAMA_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$MODEL"'",
    "temperature": 0.2,
    "messages": [
      {"role": "system", "content": "You are a planning assistant. Analyze the user request and call plan_execution with your analysis."},
      {"role": "user", "content": "mi trovi un treno da napoli a venezia per il 20 settembre"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "plan_execution",
        "description": "Submit your analysis of the user request. You MUST call this tool.",
        "parameters": {
          "type": "object",
          "properties": {
            "understanding": {"type": "string", "description": "What the user wants"},
            "complexity": {"type": "string", "enum": ["simple", "standard", "complex"]},
            "answer_directly": {"type": "boolean"},
            "intent_type": {"type": "string", "enum": ["informational", "transactional", "navigational", "creative"]},
            "success_criteria": {"type": "string"},
            "tools": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": {"type": "string"},
                  "description": {"type": "string"},
                  "reason": {"type": "string"}
                },
                "required": ["name"]
              }
            },
            "plan": {"type": "array", "items": {"type": "string"}},
            "constraints": {"type": "array", "items": {"type": "string"}}
          },
          "required": ["understanding", "complexity", "answer_directly", "intent_type", "success_criteria"]
        }
      }
    }]
  }' | python3 -m json.tool 2>/dev/null || echo "(json parse failed)"

echo ""
echo "=== TEST 2: MINIMAL schema (3 fields only) ==="
curl -s "$OLLAMA_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$MODEL"'",
    "temperature": 0.2,
    "messages": [
      {"role": "system", "content": "Analyze the user request and call plan_execution."},
      {"role": "user", "content": "mi trovi un treno da napoli a venezia per il 20 settembre"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "plan_execution",
        "description": "Submit your analysis. Call this tool with your plan.",
        "parameters": {
          "type": "object",
          "properties": {
            "understanding": {"type": "string"},
            "plan": {"type": "array", "items": {"type": "string"}},
            "tools_needed": {"type": "array", "items": {"type": "string"}}
          },
          "required": ["understanding"]
        }
      }
    }]
  }' | python3 -m json.tool 2>/dev/null || echo "(json parse failed)"

echo ""
echo "=== TEST 3: All 6 tools (discovery + plan_execution) ==="
curl -s "$OLLAMA_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$MODEL"'",
    "temperature": 0.2,
    "messages": [
      {"role": "system", "content": "You are a planning assistant. Use discovery tools to find resources, then call plan_execution with your complete analysis.\n\nWorkflow:\n1. Call discover_tools() to find available tools\n2. Call plan_execution() with your analysis\n\nIMPORTANT: You MUST call plan_execution at the end."},
      {"role": "user", "content": "mi trovi un treno da napoli a venezia per il 20 settembre"}
    ],
    "tools": [
      {"type": "function", "function": {"name": "discover_tools", "description": "Find available tools", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
      {"type": "function", "function": {"name": "search_memory", "description": "Search user memory", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
      {"type": "function", "function": {"name": "plan_execution", "description": "Submit your final analysis. You MUST call this after discovery.", "parameters": {"type": "object", "properties": {"understanding": {"type": "string"}, "complexity": {"type": "string", "enum": ["simple","standard","complex"]}, "answer_directly": {"type": "boolean"}, "intent_type": {"type": "string", "enum": ["informational","transactional","navigational","creative"]}, "success_criteria": {"type": "string"}, "tools": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "reason": {"type": "string"}}, "required": ["name"]}}, "plan": {"type": "array", "items": {"type": "string"}}, "constraints": {"type": "array", "items": {"type": "string"}}}, "required": ["understanding","complexity","answer_directly","intent_type","success_criteria"]}}}
    ]
  }' | python3 -m json.tool 2>/dev/null || echo "(json parse failed)"

echo ""
echo "Done. Check 'tool_calls' in each response."
