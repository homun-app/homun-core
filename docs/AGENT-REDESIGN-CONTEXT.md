# Agent Redesign — Context from April 2 Session

> This document captures all learnings from the intensive debugging/optimization session.
> Use as input for the architectural redesign document.

## What Was Built (and works)

1. **Cycle detection** (browser_task_plan + iteration_budget): detects A→B loops
2. **Execution discipline** (execution_plan.rs): checkpoint/rotation/give-up for all tools
3. **Budget adattivo**: Complex + steps → 55-110 iterations instead of fixed 20
4. **extract_partial_args**: salvages truncated JSON from streaming tool calls
5. **Browser signature normalization**: preserves action type (navigate vs click vs type)
6. **Task persistence**: checkpoint to DB for crash recovery + resume ChoiceBlock
7. **File download**: workspace file endpoint + download link in tool result
8. **User budget extension**: ChoiceBlock when budget exhausted instead of force-finalization
9. **Shell regex fix**: workspace readable, only sensitive files blocked

## What Does NOT Work (Root Causes)

### 1. The ReAct loop treats the LLM as a rational planner — it's not
- The model is a text generator, not a strategic thinker
- With 90K+ chars of context (old snapshots, cycle hints, tool results), the model ignores guidance
- Cycle hints ("you're repeating") are noise in a huge context — the model doesn't "learn" from them

### 2. Tool selection is fully delegated to the model — it makes bad choices
- Model navigates Google manually instead of using web_search (Brave API)
- Model clicks the same element 6x on Google results page
- Model tries evaluate() JS on every site (always fails — serialization blocked)
- Model rewrites the entire CSV from scratch every time instead of appending

### 3. The system has no data accumulation — everything lives in LLM context
- Collected data (store names, addresses) exists only in the message history
- When context is compacted, data is lost
- write_file gets truncated JSON because the CSV is too large for a single tool call
- The model should never need to generate a 10KB CSV in tool call args

### 4. Browser is used for everything — even simple web searches
- Google search should use web_search tool (structured API results)
- Browser should only be used for interactive sites (store locator with map, forms)
- The cognition plan doesn't distinguish between "search for information" and "navigate an interactive website"

### 5. Cycle detection catches repetitions but not strategic failure
- Model clicks e26 on Google 6 times — detected as cycle but model continues
- Model rewrites the same CSV 4 times — each is technically different (different truncation point)
- The system detects WHAT the model is doing wrong but can't make it do something RIGHT

## Key Numbers from Testing

| Metric | First test (pre-fix) | Latest test (all fixes) |
|--------|---------------------|------------------------|
| Budget | 20 fixed | 55-110 adaptive |
| write_file success | 0 (args={}) | ✅ (extract_partial_args) |
| CSV created | No | Yes (100+ stores, multiple files) |
| Loop detection | No (67+ iterations) | Yes (cycle detected at 4-6) |
| Total iterations used | 67 (budget extended to 100) | 16-34 per task |
| File download | No endpoint | ✅ endpoint + link |
| Task persistence | No | Schema ready (migration not applied) |

## Specific Log Evidence

### Model clicks same Google element 6 times
```
iteration=6: click e26 → 70742 bytes output
iteration=7: click e26 → 70763 bytes output
iteration=8: click e26 → 70791 bytes output
iteration=9: click e26 → 70811 bytes output
iteration=10: click e26 → 70720 bytes output
iteration=11: click e26 → 70773 bytes output
```
Output changes slightly each time (Google dynamic ads) → cycle detector thinks progress is being made.

### write_file truncated but salvaged
```
WARN Tool call arguments JSON parse failed — content may have been truncated by provider
  tool=write_file raw_len=6617 error=expected `,` or `}` at line 1 column 168
INFO Salvaged partial args from truncated JSON keys=["content", "path"]
```
The fix works — CSV is written. But the model REWRITES the entire file each time.

### evaluate() always fails
```
browser args={"action":"evaluate","expression":"const stores = []..."}
Tool execution complete tool=browser is_error=true output_len=75
```
evaluate is blocked by security filter ("Passed function is not well-serializable").
Model tries it on every site (Google, shoppingmap, paginegialle, diesel.com) — always fails.

## What Must Change (Architectural Requirements)

### 1. Tool dispatch must be system-controlled, not model-controlled
- The cognition plan should specify WHICH tool to use for each step
- Step "search for Diesel stores" → system routes to web_search, NOT browser
- Step "navigate store locator" → system routes to browser
- The model should not decide between web_search and browser

### 2. Data must accumulate outside the LLM context
- A structured data buffer (JSON/Vec in memory) collects results
- Each web_search result adds entries to the buffer
- Each browser extraction adds entries to the buffer
- write_file is called ONCE at the end with the accumulated buffer
- The model never generates a 10KB CSV — the system assembles it

### 3. Browser must have a clear purpose
- web_search (Brave API) for searching information → structured results
- web_fetch for reading static pages → extracted text
- browser ONLY for interactive sites (forms, maps, dynamic content)
- The cognition plan must classify each step's tool requirement

### 4. The system must guide the model, not the model guiding itself
- Instead of "here are 7 tools, figure it out"
- → "Step 1: I'm going to search for X. Here's the result. Step 2: Now extract Y from this page."
- The system is the strategist, the model is the executor

### 5. Profiles, memory, contacts, MCP must be first-class
- Memory scoping per contact/profile must work with the new architecture
- MCP tools must be integrated into the tool dispatch system
- Skills must be composable with the new execution model
- The redesign can't break existing channel/profile/contact contracts

## Files Changed in This Session

| Commit | Files | Lines |
|--------|-------|-------|
| 722da18 | browser_task_plan.rs, iteration_budget.rs | +246 |
| 9ed68c4 | execution_plan.rs, agent_loop.rs, db.rs, file.rs, shell.rs, chat.rs, ws.rs, chat.css, chat.js, migration, docs | +1805 |
| ecbeda7 | memory_search.rs, subagent.rs, spawn.rs | +38 |
| 5f6e3f2 | chat.rs (route fix) | +1 |
| 8dc758e | file.rs (write_file fallback) | +31 |
| 4c04199 | file.rs, execution_plan.rs (shell fallback) | +22 |
| 0daae08 | openai_compat.rs, execution_plan.rs (extract_partial_args) | +125 |
| f08b7cc | agent_loop.rs (adaptive budget) | +25 |
| 1bd9051 | agent_loop.rs, iteration_budget.rs, execution_plan.rs (signature fix + user budget extension) | +124 |

## Next Session: Create the Architectural Document

The document must answer:
1. How does a task flow from user request to completed output?
2. How does the system decide which tool to use for each step?
3. How is data accumulated across steps?
4. When does the browser get used vs web_search vs web_fetch?
5. How do profiles, memory, contacts scope into each step?
6. How do MCP tools and skills integrate?
7. How does the system handle failures without losing work?
8. How does the system communicate progress to the user?

This is not a code refactor — it's an architecture redesign that may require rewriting
the agent loop, cognition, and execution plan from the ground up.
