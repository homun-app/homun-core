'use strict';

(function () {
    var root = document.querySelector('[data-app-slug]');
    if (!root) return;
    var slug = root.dataset.appSlug;

    function api(path, options) {
        return fetch('/api/a/' + encodeURIComponent(slug) + path, options).then(function (res) {
            return res.text().then(function (text) {
                var body = text ? JSON.parse(text) : null;
                if (!res.ok) throw new Error((body && body.error) || 'Request failed');
                return body;
            });
        });
    }

    var loginForm = document.getElementById('external-login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', function (event) {
            event.preventDefault();
            var data = new FormData(loginForm);
            api('/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: data.get('email'),
                    password: data.get('password')
                })
            }).then(function () {
                location.href = '/a/' + encodeURIComponent(slug);
            }).catch(function (err) {
                document.getElementById('external-login-error').textContent = err.message;
            });
        });
        return;
    }

    var userEl = document.getElementById('external-app-user');
    api('/me').then(function (me) {
        if (userEl) userEl.textContent = me.display_name + ' - ' + me.role;
    }).catch(function () {
        location.href = '/a/' + encodeURIComponent(slug) + '/login';
    });

    var logout = document.getElementById('external-logout');
    if (logout) {
        logout.addEventListener('click', function () {
            api('/logout', { method: 'POST' }).finally(function () {
                location.href = '/a/' + encodeURIComponent(slug) + '/login';
            });
        });
    }
}());
