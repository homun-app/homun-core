use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Serialize;

pub(crate) trait GatewayAuthState {
    fn gateway_auth_token(&self) -> &str;
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

pub(crate) fn bearer_is_authorized(headers: &HeaderMap, expected_token: &str) -> bool {
    let expected = format!("Bearer {expected_token}");
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected)
}

fn gateway_unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(ErrorResponse {
            error: ErrorBody {
                code: "gateway_unauthorized",
                message: "Missing or invalid Desktop Gateway token".to_string(),
            },
        }),
    )
        .into_response()
}

pub(crate) async fn require_gateway_token<S>(
    State(state): State<S>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response
where
    S: GatewayAuthState + Clone + Send + Sync + 'static,
{
    if bearer_is_authorized(&headers, state.gateway_auth_token()) {
        next.run(request).await
    } else {
        gateway_unauthorized_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::to_bytes, http::HeaderValue, routing::get};
    use serde_json::Value;
    use tower::ServiceExt;

    #[derive(Clone)]
    struct TestAuthState;

    impl GatewayAuthState for TestAuthState {
        fn gateway_auth_token(&self) -> &str {
            "secret-token"
        }
    }

    fn protected_app() -> Router {
        Router::new()
            .route("/protected", get(|| async { "ok" }))
            .route_layer(axum::middleware::from_fn_with_state(
                TestAuthState,
                require_gateway_token::<TestAuthState>,
            ))
    }

    #[test]
    fn bearer_auth_accepts_exact_gateway_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer secret-token"),
        );

        assert!(bearer_is_authorized(&headers, "secret-token"));
    }

    #[test]
    fn bearer_auth_rejects_missing_or_different_tokens() {
        assert!(!bearer_is_authorized(&HeaderMap::new(), "secret-token"));

        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer other-token"),
        );

        assert!(!bearer_is_authorized(&headers, "secret-token"));
    }

    #[tokio::test]
    async fn middleware_rejects_missing_token_with_gateway_error_shape() {
        let response = protected_app()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/protected")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["error"]["code"], "gateway_unauthorized");
        assert_eq!(
            value["error"]["message"],
            "Missing or invalid Desktop Gateway token"
        );
    }

    #[tokio::test]
    async fn middleware_allows_matching_bearer_token() {
        let response = protected_app()
            .oneshot(
                axum::http::Request::builder()
                    .uri("/protected")
                    .header(AUTHORIZATION, "Bearer secret-token")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"ok");
    }
}
