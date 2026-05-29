use local_first_subagents::{GenerateRequest, GenerateStreamEvent, RuntimeClient};
use std::time::Instant;

fn main() {
    let prompt = std::env::args()
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();
    let prompt = if prompt.is_empty() {
        "scrivimi un esempio di codice Rust di 300 righe".to_string()
    } else {
        prompt
    };
    let client = RuntimeClient::new("http://127.0.0.1:8765");
    let request = GenerateRequest {
        prompt,
        max_tokens: 4096,
        temperature: 0.0,
        wait_if_busy: true,
        request_timeout_seconds: Some(240.0),
        request_id: Some("rust_stream_probe".to_string()),
    };
    let started = Instant::now();
    let mut last = started;
    let mut chunks = 0_u32;
    let mut chars = 0_usize;
    let mut gaps = 0_u32;
    println!("RUST_CLIENT start");
    let result = client.generate_stream(&request, |event| {
        let now = Instant::now();
        if let GenerateStreamEvent::Delta { text } = event {
            chunks += 1;
            chars += text.len();
            if chunks == 1 {
                println!(
                    "first_delta {:.3}s {:?}",
                    now.duration_since(started).as_secs_f64(),
                    text.chars().take(80).collect::<String>()
                );
            }
            let gap = now.duration_since(last).as_secs_f64();
            if gap > 2.0 {
                gaps += 1;
                println!(
                    "GAP {:.3}s gap {:.3}s chunks {} chars {} {:?}",
                    now.duration_since(started).as_secs_f64(),
                    gap,
                    chunks,
                    chars,
                    text.chars().take(80).collect::<String>()
                );
            }
            if chunks % 100 == 0 {
                println!(
                    "progress {:.3}s chunks {} chars {}",
                    now.duration_since(started).as_secs_f64(),
                    chunks,
                    chars
                );
            }
            last = now;
        }
    });
    let finished = Instant::now();
    match result {
        Ok(response) => {
            println!(
                "DONE first_total {:.3}s chunks {} chars {} gaps_gt_2s {} generation_tokens {}",
                finished.duration_since(started).as_secs_f64(),
                chunks,
                chars,
                gaps,
                response.metrics.generation_tokens
            );
        }
        Err(error) => {
            eprintln!("ERROR {error:?}");
            std::process::exit(1);
        }
    }
}
