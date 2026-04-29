use std::sync::Arc;

use axum::extract::Path;
use axum::response::Html;
use axum::Router;

use crate::web::server::AppState;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/a/{slug}/login", axum::routing::get(login_page))
        .route("/a/{slug}", axum::routing::get(app_page))
}

async fn login_page(Path(slug): Path<String>) -> Html<String> {
    Html(external_page(
        "Sign in",
        &format!(
            r#"<main class="external-app-login" data-app-slug="{slug}">
    <section class="external-login-panel">
        <h1>Sign in</h1>
        <p>Access this workspace app.</p>
        <form id="external-login-form">
            <label>Email<input class="input" name="email" type="email" autocomplete="email" required></label>
            <label>Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>
            <button class="btn btn-primary" type="submit">Sign in</button>
            <p class="external-error" id="external-login-error"></p>
        </form>
    </section>
</main>"#
        ),
        &slug,
    ))
}

async fn app_page(Path(slug): Path<String>) -> Html<String> {
    Html(external_page(
        "App",
        &format!(
            r#"<main class="external-app-shell" data-app-slug="{slug}">
    <header class="external-app-header">
        <div>
            <h1 id="external-app-title">App</h1>
            <p id="external-app-user"></p>
        </div>
        <button class="btn btn-secondary btn-sm" id="external-logout">Logout</button>
    </header>
    <nav class="external-app-nav" id="external-app-nav"></nav>
    <section class="external-app-dashboard" id="external-app-dashboard"></section>
    <section class="external-app-body">
        <div class="external-app-table" id="external-app-table"></div>
        <aside class="external-app-form" id="external-app-form"></aside>
    </section>
</main>"#
        ),
        &slug,
    ))
}

fn external_page(title: &str, body: &str, slug: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} - {slug}</title>
  <link rel="stylesheet" href="/static/css/tokens.css">
  <link rel="stylesheet" href="/static/css/reset.css">
  <link rel="stylesheet" href="/static/css/primitives.css">
  <link rel="stylesheet" href="/static/css/external-app.css">
</head>
<body>
{body}
<script src="/static/js/external-app.js"></script>
</body>
</html>"#
    )
}
