use crate::{
    GenerateJsonRequest, GenerateJsonResponse, GenerateRequest, GenerateResponse,
    GenerateStreamEvent, IntentClassifyRequest, RuntimeWarmupResponse,
};
use serde::Serialize;
use std::io::Read;

pub struct RuntimeClient {
    base_url: String,
    http: reqwest::blocking::Client,
}

impl RuntimeClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: reqwest::blocking::Client::new(),
        }
    }

    pub fn endpoint(&self, path: &str) -> String {
        format!("{}/{}", self.base_url, path.trim_start_matches('/'))
    }

    pub fn cancel_generation(&self, request_id: &str) -> Result<(), RuntimeClientError> {
        #[derive(Serialize)]
        struct CancelGenerationRequest<'a> {
            request_id: &'a str,
        }

        let response = self
            .http
            .post(self.endpoint("/cancel_generation"))
            .json(&CancelGenerationRequest { request_id })
            .send()
            .map_err(RuntimeClientError::Request)?;

        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }

        Ok(())
    }

    pub fn warmup(&self) -> Result<RuntimeWarmupResponse, RuntimeClientError> {
        let response = self
            .http
            .post(self.endpoint("/warmup"))
            .send()
            .map_err(RuntimeClientError::Request)?;

        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }

        response.json().map_err(RuntimeClientError::Request)
    }

    pub fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let response = self
            .http
            .post(self.endpoint("/generate_json"))
            .json(request)
            .send()
            .map_err(RuntimeClientError::Request)?;

        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }

        response.json().map_err(RuntimeClientError::Request)
    }

    pub fn generate(
        &self,
        request: &GenerateRequest,
    ) -> Result<GenerateResponse, RuntimeClientError> {
        let response = self
            .http
            .post(self.endpoint("/generate"))
            .json(request)
            .send()
            .map_err(RuntimeClientError::Request)?;

        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }

        response.json().map_err(RuntimeClientError::Request)
    }

    pub fn generate_stream<F>(
        &self,
        request: &GenerateRequest,
        on_event: F,
    ) -> Result<GenerateResponse, RuntimeClientError>
    where
        F: FnMut(GenerateStreamEvent),
    {
        let response = self
            .http
            .post(self.endpoint("/generate_stream"))
            .json(request)
            .send()
            .map_err(RuntimeClientError::Request)?;

        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }

        consume_generate_stream_response(response, on_event)
    }

    pub fn classify_intent(
        &self,
        request: &IntentClassifyRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let response = self
            .http
            .post(self.endpoint("/classify_intent"))
            .json(request)
            .send()
            .map_err(RuntimeClientError::Request)?;

        if !response.status().is_success() {
            return Err(RuntimeClientError::Status(response.status().as_u16()));
        }

        response.json().map_err(RuntimeClientError::Request)
    }
}

fn consume_generate_stream_response<F>(
    mut response: reqwest::blocking::Response,
    mut on_event: F,
) -> Result<GenerateResponse, RuntimeClientError>
where
    F: FnMut(GenerateStreamEvent),
{
    let mut final_response = None;
    let mut buffer = String::new();

    let mut chunk = [0_u8; 4096];
    loop {
        let read = response.read(&mut chunk).map_err(RuntimeClientError::Io)?;
        if read == 0 {
            break;
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk[..read]));
        consume_stream_buffer_lines(&mut buffer, &mut final_response, &mut on_event)?;
    }

    if !buffer.trim().is_empty() {
        let line = std::mem::take(&mut buffer);
        consume_stream_line(line.trim(), &mut final_response, &mut on_event)?;
    }

    final_response.ok_or(RuntimeClientError::StreamEndedWithoutDone)
}

fn consume_stream_buffer_lines<F>(
    buffer: &mut String,
    final_response: &mut Option<GenerateResponse>,
    on_event: &mut F,
) -> Result<(), RuntimeClientError>
where
    F: FnMut(GenerateStreamEvent),
{
    while let Some(newline_index) = buffer.find('\n') {
        let line = buffer[..newline_index].to_string();
        buffer.replace_range(..=newline_index, "");
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            consume_stream_line(trimmed, final_response, on_event)?;
        }
    }
    Ok(())
}

fn consume_stream_line<F>(
    line: &str,
    final_response: &mut Option<GenerateResponse>,
    on_event: &mut F,
) -> Result<(), RuntimeClientError>
where
    F: FnMut(GenerateStreamEvent),
{
    let event: GenerateStreamEvent =
        serde_json::from_str(line).map_err(RuntimeClientError::Json)?;
    if let GenerateStreamEvent::Error { code, message } = &event {
        return Err(RuntimeClientError::Runtime {
            code: code.clone(),
            message: message.clone(),
        });
    }
    if let GenerateStreamEvent::Done { text, metrics, .. } = &event {
        *final_response = Some(GenerateResponse {
            text: text.clone(),
            metrics: metrics.clone(),
        });
    }
    on_event(event);
    Ok(())
}

pub trait IntentRuntime {
    fn classify_intent(
        &self,
        request: &IntentClassifyRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError>;
}

pub trait TextRuntime {
    fn generate(&self, request: &GenerateRequest) -> Result<GenerateResponse, RuntimeClientError>;
}

pub trait TextStreamRuntime {
    fn generate_stream<F>(
        &self,
        request: &GenerateRequest,
        on_event: F,
    ) -> Result<GenerateResponse, RuntimeClientError>
    where
        F: FnMut(GenerateStreamEvent);
}

pub trait JsonRuntime {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError>;
}

/// Lets a shared runtime (e.g. `Arc<ModelRouter>`) be used wherever a
/// `JsonRuntime` is expected, so a loaded-once model can be cloned cheaply
/// across many consumers without reloading.
impl<T: JsonRuntime + ?Sized> JsonRuntime for std::sync::Arc<T> {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        (**self).generate_json(request)
    }
}

impl TextRuntime for RuntimeClient {
    fn generate(&self, request: &GenerateRequest) -> Result<GenerateResponse, RuntimeClientError> {
        RuntimeClient::generate(self, request)
    }
}

impl TextStreamRuntime for RuntimeClient {
    fn generate_stream<F>(
        &self,
        request: &GenerateRequest,
        on_event: F,
    ) -> Result<GenerateResponse, RuntimeClientError>
    where
        F: FnMut(GenerateStreamEvent),
    {
        RuntimeClient::generate_stream(self, request, on_event)
    }
}

impl JsonRuntime for RuntimeClient {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        RuntimeClient::generate_json(self, request)
    }
}

impl IntentRuntime for RuntimeClient {
    fn classify_intent(
        &self,
        request: &IntentClassifyRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        RuntimeClient::classify_intent(self, request)
    }
}

#[derive(Debug)]
pub enum RuntimeClientError {
    Request(reqwest::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    Status(u16),
    StreamEndedWithoutDone,
    Runtime { code: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_parser_accepts_split_ndjson_chunks() {
        let mut buffer = "{\"type\":\"delta\",\"text\":\"Ci".to_string();
        let mut events = Vec::new();
        let mut final_response = None;

        consume_stream_buffer_lines(&mut buffer, &mut final_response, &mut |event| {
            events.push(event)
        })
        .unwrap();
        assert!(events.is_empty());

        buffer.push_str("ao\"}\n{\"type\":\"done\",\"text\":\"Ciao\",\"metrics\":{\"prompt_tokens\":1,\"generation_tokens\":1,\"prompt_tps\":1.0,\"generation_tps\":1.0,\"peak_memory_gb\":1.0,\"elapsed_seconds\":0.1}}\n");
        consume_stream_buffer_lines(&mut buffer, &mut final_response, &mut |event| {
            events.push(event)
        })
        .unwrap();

        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0],
            GenerateStreamEvent::Delta {
                text: "Ciao".to_string()
            }
        );
        assert_eq!(final_response.unwrap().text, "Ciao");
        assert!(buffer.is_empty());
    }
}
