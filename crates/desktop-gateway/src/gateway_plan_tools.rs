// Tool schemas for the runtime plan surface.

pub(crate) fn update_plan_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "update_plan",
            "description": "Create or update the operational step-by-step PLAN of a NON-trivial task \
    (multi-step: development, refactor, in-depth research). It appears in the \"Plan\" panel and the user \
    follows progress. Call it at the START with ALL steps (status \"todo\", the first \"doing\") and UPDATE \
    IT as you proceed (move to \"done\" what you completed, set \"doing\" the current step). Do NOT use it \
    for single-step requests.",
            "strict": true,
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "steps": {
                        "type": "array",
                        "description": "The plan steps, in order.",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "id": { "type": ["string", "null"], "description": "When UPDATING an existing step, echo its id EXACTLY as shown in the plan (the `(`id`)` after the title, e.g. \"s2\"). This keeps the step stable even if you rephrase its title. Use null for a brand-new step." },
                                "title": { "type": "string", "description": "What the step does (short, imperative)." },
                                "status": { "type": "string", "enum": ["todo", "doing", "done", "blocked"], "description": "Current status of the step." },
                                "detail": { "type": ["string", "null"], "description": "Optional detail." },
                                "depends_on": {
                                    "type": ["array", "null"],
                                    "items": { "type": "string" },
                                    "description": "Optional explicit dependencies by stable step id, e.g. [\"s1\"]. Do not infer dependencies; include only when the workflow requires this step to wait for another. Use null when none."
                                },
                                "done_criterion": { "type": ["string", "null"], "description": "Optional but RECOMMENDED: the concrete, checkable condition that proves this step is complete (e.g. \"file report.pdf written\", \"search returned >=5 relevant sources\", \"deck rendered to PDF without errors\"). Used to verify completion before advancing." }
                            },
                            "required": ["id", "title", "status", "detail", "depends_on", "done_criterion"]
                        }
                    }
                },
                "required": ["steps"]
            }
        }
    })
}

/// Report progress on a single plan step by stable id, without re-sending the whole plan.
pub(crate) fn step_advance_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "step_advance",
            "description": "Set a SINGLE plan step's new status by its id (e.g. move it to \"done\" when you finish it), WITHOUT re-sending the whole plan. This is the preferred way to report progress as you work; use update_plan only to CREATE or revise the plan. The id is shown in parentheses after each step's title in the Plan card.",
            "strict": true,
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "id": { "type": "string", "description": "The step id, EXACTLY as shown in the Plan card (e.g. \"s2\")." },
                    "status": { "type": "string", "enum": ["todo", "doing", "done", "blocked"], "description": "The step's new status." },
                    "detail": { "type": ["string", "null"], "description": "Optional updated detail." }
                },
                "required": ["id", "status", "detail"]
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_plan_tools_keep_strict_schema_contracts() {
        let update = update_plan_tool_schema();
        assert_eq!(update["function"]["name"], serde_json::json!("update_plan"));
        assert_eq!(update["function"]["strict"], serde_json::json!(true));
        assert_eq!(
            update["function"]["parameters"]["properties"]["steps"]["items"]["required"],
            serde_json::json!([
                "id",
                "title",
                "status",
                "detail",
                "depends_on",
                "done_criterion"
            ])
        );

        let advance = step_advance_tool_schema();
        assert_eq!(
            advance["function"]["name"],
            serde_json::json!("step_advance")
        );
        assert_eq!(advance["function"]["strict"], serde_json::json!(true));
        assert_eq!(
            advance["function"]["parameters"]["required"],
            serde_json::json!(["id", "status", "detail"])
        );
    }
}
