# Gemma 4 Browser Context Ablation

Date: 2026-05-28

## Goal

Find the smallest browser context that still lets Gemma 4 execute the plan
without guessing. This benchmark distinguishes:

- raw context overload;
- compact context that preserves the plan;
- over-compression that removes necessary controls or failure memory.

## Runtime Switch

The desktop gateway browser-loop planner reads:

```bash
HOMUN_BROWSER_CONTEXT_PROFILE=compact
```

Supported values:

| Profile | Meaning | Use |
| --- | --- | --- |
| `full` | Larger raw snapshot frame, truncated late | Baseline for overload detection |
| `compact` | Default budgeted action frame with relevant refs, goal matches, and failure memory | Candidate default |
| `minimal` | Very small interactive-only frame | Over-compression boundary |

Keep model, quantization, runner flags, task prompt, browser fixture, and task
order fixed while changing only this variable.

## Task Set

Run each profile three times from a clean browser state:

| Task | Required preserved context | Success condition |
| --- | --- | --- |
| Open page | Goal, URL, page title | Opens target page and reports the correct title |
| Extract value | Goal, page title, relevant label/value | Returns the requested value without unrelated text |
| Click path | Goal, visible control label/ref | Clicks the correct control and observes progress |
| Form fill | Goal, field labels/refs, submit/search control | Types once, submits/searches once, reaches expected result |
| Recovery | Goal, last failed action/ref, alternate controls | Does not repeat the failed action blindly |

Train-search live checks should include TrovaTreno first, then direct
Trenitalia and ItaloTreno only after fixture parity remains green.

## Metrics

Record these per run:

| Metric | Why |
| --- | --- |
| Prompt chars/tokens | Confirms context budget |
| Completion chars/tokens | Detects rambling after missing context |
| Valid planner JSON | Confirms tool-call path |
| Correct next action | Confirms plan retention |
| Task completion | End-to-end outcome |
| Repeated failed action | Detects missing failure memory |
| Invented selector/value | Detects over-compression |
| Blocked reason | Distinguishes site blocker from model/context failure |

## Result Template

```markdown
# Gemma 4 Browser Context Ablation Result

## Metadata

- Date:
- Model:
- Quant:
- Runner:
- Context length:
- Cache settings:
- Browser fixture/site:

## Profile Scores

| Profile | Avg prompt chars | Valid planner JSON | Completed runs | Repeated failures | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| full |  |  |  |  |  |
| compact |  |  |  |  |  |
| minimal |  |  |  |  |  |

## Missing Context Findings

## Overload Findings

## Selected Default

## Follow-up Changes
```

## Decision Rules

| Result | Interpretation | Next action |
| --- | --- | --- |
| `full` fails, `compact` passes | Raw context overload confirmed | Keep compact as default |
| `full` passes, `compact` fails | Compact removed required context | Add the missing field/ref class back |
| `compact` passes, `minimal` fails | Compression boundary found | Keep compact budget |
| `compact` repeats failed refs | Failure memory is insufficient | Preserve last failed ref/status/reason |
| All profiles fail | Not context-size-only | Check Gemma template, JSON parser, model size, sidecar action errors |

Do not accept a profile only because it is smaller. Accept it only when it
preserves enough context for the next action and the task plan.

## 2026-05-28 Smoke Result

Artifact:
`output/gemma4-browser-context-smoke-20260528-193119/result.md`

Live browser smoke used the same train task with
`HOMUN_BROWSER_LOOP_MAX_ITERATIONS=1` to compare context profiles without
spending the run mostly on site retries.

| Profile | Avg prompt chars | Valid planner JSON-ish | End status | Finding |
| --- | ---: | ---: | --- | --- |
| `full` | 16,177 | 4/4 | failed | Large context, valid JSON, same sidecar tab failure |
| `compact` | 8,666 | 4/4 | failed | 46% smaller than full, valid JSON, same sidecar tab failure |
| `minimal` | 4,986 | 4/4 | failed | Smallest, but responses show more generic refs and weaker grounding |

Decision: keep `compact` as the default. The smoke did not expose a JSON
validity regression from compaction, and `minimal` looks too aggressive for
normal use. The shared failure was
`BROWSER_TAB_NOT_FOUND: tab not found: loop_0`, so the next live blocker is
browser tab lifecycle/target reuse rather than context-size-only behavior.

External reference considered:
the Reddit OpenClaw/Gemma 4 TurboQuant post describes the same class of issue:
agentic local models on mid-range Mac hardware become difficult when OpenClaw
adds large context to every request, and their mitigation combines context/cache
preparation with TurboQuant-style cache compression.
