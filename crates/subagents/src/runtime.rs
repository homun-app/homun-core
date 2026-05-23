use crate::{GenerateJsonRequest, GenerateJsonResponse};

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
}

pub trait JsonRuntime {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError>;
}

impl JsonRuntime for RuntimeClient {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        RuntimeClient::generate_json(self, request)
    }
}

#[derive(Debug)]
pub enum RuntimeClientError {
    Request(reqwest::Error),
    Status(u16),
}
