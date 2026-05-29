use local_first_context_compression::{
    CompressionPolicy, ContextCompressor, ContextItem, ContextKind,
};

#[test]
fn shell_output_preserves_failures_tail_and_redacts_before_truncation() {
    let mut lines = Vec::new();
    lines.push("Compiling local-first".to_string());
    lines.extend((0..24).map(|_| "warning: repeated noisy line".to_string()));
    lines.push("error[E0425]: cannot find value `api_key`".to_string());
    lines.push("TOKEN=sk-secret-value should never leak".to_string());
    lines.push("test result: FAILED. 1 failed; 3 passed".to_string());
    let input = lines.join("\n");

    let result = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::ShellOutput, input),
        &CompressionPolicy::for_kind(ContextKind::ShellOutput).with_max_chars(260),
    );

    assert!(result.compressed);
    assert!(result.text.contains("error[E0425]"));
    assert!(result.text.contains("test result: FAILED"));
    assert!(result.text.contains("[REDACTED]"));
    assert!(!result.text.contains("sk-secret-value"));
    assert!(result.text.contains("repeated"));
    assert!(result.text.contains("context compressed"));
    assert!(result.metrics.input_chars > result.metrics.output_chars);
    assert!(result.metrics.redaction_count >= 1);
}

#[test]
fn browser_text_preserves_title_and_urls_but_strips_query_secrets() {
    let input = [
        "Page title: Trenitalia Search",
        "https://example.test/search?token=secret&q=napoli",
        "Navigation Home Login Cookie banner",
        "Risultato: Napoli Centrale -> Milano Centrale 09:10",
        "Prezzo indicativo 54 euro",
    ]
    .join("\n");

    let result = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::BrowserText, input),
        &CompressionPolicy::for_kind(ContextKind::BrowserText).with_max_chars(220),
    );

    assert!(result.text.contains("Page title: Trenitalia Search"));
    assert!(result.text.contains("https://example.test/search"));
    assert!(!result.text.contains("token=secret"));
    assert!(result.text.contains("Napoli Centrale"));
    assert!(result.text.contains("54 euro"));
}

#[test]
fn chat_history_keeps_recent_turns_and_collapses_older_context() {
    let input = [
        "Utente: primo messaggio molto vecchio sul progetto Acme",
        "Assistant: risposta molto vecchia con dettagli non essenziali",
        "Utente: preferisco Rust",
        "Assistant: nota ricevuta",
        "Utente: ora fammi un esempio",
        "Assistant: ecco un esempio breve",
    ]
    .join("\n");

    let result = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::ChatHistory, input),
        &CompressionPolicy::for_kind(ContextKind::ChatHistory).with_max_chars(170),
    );

    assert!(result.compressed);
    assert!(result.text.contains("Earlier context"));
    assert!(result.text.contains("Utente: ora fammi un esempio"));
    assert!(result.text.contains("Assistant: ecco un esempio breve"));
    assert!(
        !result
            .text
            .contains("risposta molto vecchia con dettagli non essenziali")
    );
}

#[test]
fn json_tool_output_redacts_sensitive_fields_recursively() {
    let input = serde_json::json!({
        "ok": true,
        "profile": {
            "email": "fabio@example.com",
            "access_token": "secret-token",
            "nested": { "api_key": "sk-secret" }
        },
        "items": ["safe", {"password": "secret"}]
    })
    .to_string();

    let result = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::ToolJson, input),
        &CompressionPolicy::for_kind(ContextKind::ToolJson).with_max_chars(400),
    );

    assert!(result.text.contains("\"ok\":true"));
    assert!(result.text.contains("[REDACTED]"));
    assert!(!result.text.contains("fabio@example.com"));
    assert!(!result.text.contains("secret-token"));
    assert!(!result.text.contains("sk-secret"));
}

#[test]
fn generic_output_reports_token_estimates_and_ratio() {
    let result = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::GenericToolOutput, "a ".repeat(200)),
        &CompressionPolicy::for_kind(ContextKind::GenericToolOutput).with_max_chars(120),
    );

    assert!(result.metrics.estimated_input_tokens > result.metrics.estimated_output_tokens);
    assert!(result.metrics.compression_ratio > 0.0);
    assert!(result.metrics.compression_ratio < 1.0);
}
