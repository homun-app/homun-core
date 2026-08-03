use axum::http::{
    HeaderName, HeaderValue, Method,
    header::{AUTHORIZATION, CONTENT_TYPE},
};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub(crate) fn default_allowed_origins() -> Vec<HeaderValue> {
    vec![
        HeaderValue::from_static("http://127.0.0.1:1420"),
        HeaderValue::from_static("http://localhost:1420"),
        HeaderValue::from_static("http://127.0.0.1:1421"),
        HeaderValue::from_static("http://localhost:1421"),
        HeaderValue::from_static("null"),
    ]
}

pub(crate) fn allowed_origins(env_origin: Option<&str>) -> Vec<HeaderValue> {
    let mut origins = default_allowed_origins();
    if let Some(origin) = env_origin
        && let Ok(header) = HeaderValue::from_str(origin.trim())
    {
        origins.push(header);
    }
    origins
}

pub(crate) fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins(
            std::env::var("HOMUN_DESKTOP_ALLOWED_ORIGIN")
                .ok()
                .as_deref(),
        )))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([CONTENT_TYPE, AUTHORIZATION])
        // Custom response headers are hidden from browser `fetch` unless exposed.
        .expose_headers([HeaderName::from_static("x-effective-model")])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_origins_include_dev_preview_and_packaged_file_origin() {
        let origins = default_allowed_origins();

        assert!(origins.contains(&HeaderValue::from_static("http://127.0.0.1:1420")));
        assert!(origins.contains(&HeaderValue::from_static("http://localhost:1420")));
        assert!(origins.contains(&HeaderValue::from_static("http://127.0.0.1:1421")));
        assert!(origins.contains(&HeaderValue::from_static("http://localhost:1421")));
        assert!(origins.contains(&HeaderValue::from_static("null")));
    }

    #[test]
    fn allowed_origins_appends_valid_env_override_only() {
        let origins = allowed_origins(Some("http://127.0.0.1:1555"));
        assert!(origins.contains(&HeaderValue::from_static("http://127.0.0.1:1555")));

        let invalid = allowed_origins(Some("bad\u{7f}origin"));
        assert_eq!(invalid, default_allowed_origins());
    }
}
