use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(id) = request.get("id").cloned() else {
            continue;
        };
        let method = request
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let result = match method {
            "initialize" => serde_json::json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {"listChanged": true}},
                "serverInfo": {"name": "fake_mcp_stdio", "version": "0.1.0"}
            }),
            "tools/list" => serde_json::json!({
                "tools": [{
                    "name": "echo",
                    "description": "Echo text",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                        "required": ["text"]
                    }
                }]
            }),
            "tools/call" => {
                let text = request
                    .pointer("/params/arguments/text")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                serde_json::json!({
                    "content": [{"type": "text", "text": text}],
                    "structuredContent": {"text": text}
                })
            }
            _ => serde_json::json!({}),
        };
        let response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        });
        let _ = writeln!(stdout, "{response}");
        let _ = stdout.flush();
    }
}
