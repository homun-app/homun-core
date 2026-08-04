use axum::{Json, response::IntoResponse};
use local_first_desktop_gateway::{
    BuildPromptRequest, BuildPromptResponse, build_chat_runtime_prompt,
};

pub(crate) async fn build_prompt(Json(request): Json<BuildPromptRequest>) -> impl IntoResponse {
    Json(build_prompt_response(request))
}

fn build_prompt_response(request: BuildPromptRequest) -> BuildPromptResponse {
    build_chat_runtime_prompt(&request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prompt_response_delegates_to_runtime_prompt_builder() {
        let request = BuildPromptRequest {
            prompt: "Trova un treno per Firenze".to_string(),
            context: Vec::new(),
            max_context_chars: Some(256),
        };

        let expected = build_chat_runtime_prompt(&request);
        let actual = build_prompt_response(request);

        assert_eq!(actual, expected);
    }
}
