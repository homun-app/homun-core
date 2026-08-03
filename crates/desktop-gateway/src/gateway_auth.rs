use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::{fs, path::Path};

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

pub(crate) fn gateway_token_from_env() -> String {
    std::env::var("HOMUN_DESKTOP_GATEWAY_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(crate) fn resolve_gateway_auth_token(
    data_dir: &Path,
    write_private_file: impl Fn(&Path, &[u8]) -> Result<(), std::io::Error>,
) -> Result<String, std::io::Error> {
    resolve_gateway_auth_token_with_explicit(
        &gateway_token_from_env(),
        data_dir,
        write_private_file,
    )
}

fn resolve_gateway_auth_token_with_explicit(
    explicit_token: &str,
    data_dir: &Path,
    write_private_file: impl Fn(&Path, &[u8]) -> Result<(), std::io::Error>,
) -> Result<String, std::io::Error> {
    let from_env = explicit_token.trim();
    if !from_env.is_empty() {
        return Ok(from_env.to_string());
    }

    let token_path = data_dir.join("desktop-gateway-token");
    if let Ok(existing) = fs::read_to_string(&token_path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }

    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    write_private_file(&token_path, token.as_bytes())?;
    eprintln!(
        "[gateway] no HOMUN_DESKTOP_GATEWAY_TOKEN set; generated a local token at {} (auth required)",
        token_path.display()
    );
    Ok(token)
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
    use std::cell::RefCell;
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

    #[test]
    fn auth_token_resolution_prefers_explicit_token() {
        let writes = RefCell::new(Vec::new());

        let token = resolve_gateway_auth_token_with_explicit(
            " explicit-token ",
            Path::new("/tmp"),
            |path, bytes| {
                writes
                    .borrow_mut()
                    .push((path.to_path_buf(), bytes.to_vec()));
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(token, "explicit-token");
        assert!(writes.borrow().is_empty());
    }

    #[test]
    fn auth_token_resolution_reads_existing_persisted_token() {
        let temp_dir = std::env::temp_dir().join(format!(
            "gateway-auth-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&temp_dir).unwrap();
        fs::write(
            temp_dir.join("desktop-gateway-token"),
            " persisted-token \n",
        )
        .unwrap();

        let token = resolve_gateway_auth_token_with_explicit("", &temp_dir, |_path, _bytes| {
            panic!("existing token should not be overwritten")
        })
        .unwrap();

        assert_eq!(token, "persisted-token");
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn auth_token_resolution_generates_and_persists_when_missing() {
        let temp_dir = std::env::temp_dir().join(format!(
            "gateway-auth-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&temp_dir).unwrap();

        let token = resolve_gateway_auth_token_with_explicit("", &temp_dir, |path, bytes| {
            fs::write(path, bytes)
        })
        .unwrap();

        assert_eq!(token.len(), 64);
        assert_eq!(
            fs::read_to_string(temp_dir.join("desktop-gateway-token")).unwrap(),
            token
        );
        let _ = fs::remove_dir_all(temp_dir);
    }
}
