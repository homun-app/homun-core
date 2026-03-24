// Homun — API Keys management page
// All dynamic content inserted via innerHTML uses esc() to prevent XSS.
// Supports both standalone page and settings modal contexts.

(function () {
    'use strict';

    function initApiKeys() {
        // ─── DOM refs ───
        var keysList = document.getElementById('keys-list');
        var keysEmpty = document.getElementById('keys-empty');
        var keysCount = document.getElementById('keys-count');
        var createSection = document.getElementById('create-form-section');
        var revealSection = document.getElementById('token-reveal-section');
        var revealedToken = document.getElementById('revealed-token');
        var createForm = document.getElementById('create-key-form');
        var createBtn = document.getElementById('create-key-btn');
        var cancelCreateBtn = document.getElementById('cancel-create-btn');
        var copyTokenBtn = document.getElementById('copy-token-btn');
        var dismissRevealBtn = document.getElementById('dismiss-reveal-btn');

        // Guard: skip init if DOM elements are missing (wrong context)
        if (!keysList || !createForm) return;

        // ─── State ───
        var keys = [];

        // ─── Load keys from API ───
        async function loadKeys() {
            try {
                var resp = await fetch('/api/v1/account/tokens');
                if (!resp.ok) throw new Error('Failed to load keys');
                keys = await resp.json();
                renderKeys();
            } catch (e) {
                console.error('[api-keys] loadKeys error:', e);
                if (keysEmpty) {
                    keysEmpty.textContent = 'Failed to load API keys.';
                    keysEmpty.style.display = '';
                }
            }
        }

        // ─── Render key list ───
        // Uses esc() to sanitize all API values before DOM insertion.
        function renderKeys() {
            if (keysCount) keysCount.textContent = keys.length;

            // Clear old rows
            keysList.querySelectorAll('.key-row').forEach(function (el) { el.remove(); });

            if (keys.length === 0) {
                if (keysEmpty) keysEmpty.style.display = '';
                return;
            }
            if (keysEmpty) keysEmpty.style.display = 'none';

            keys.forEach(function (k) {
                var row = document.createElement('div');
                row.className = 'key-row item-row';
                row.dataset.tokenId = k.token_id;

                var scopeClass = k.scope === 'admin' ? 'badge-info'
                    : k.scope === 'write' ? 'badge-warning'
                    : 'badge-neutral';

                var enabledLabel = k.enabled ? 'Enabled' : 'Disabled';
                var enabledClass = k.enabled ? 'badge-success' : 'badge-danger';
                var toggleLabel = k.enabled ? 'Disable' : 'Enable';
                var lastUsed = k.last_used ? timeAgo(k.last_used) : 'Never';

                // Build row — esc() sanitizes all dynamic API values to prevent XSS
                var info = document.createElement('div');
                info.style.cssText = 'flex:1;min-width:0';

                var nameRow = document.createElement('div');
                nameRow.style.cssText = 'display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap';
                var strong = document.createElement('strong');
                strong.textContent = k.name;
                nameRow.appendChild(strong);
                nameRow.appendChild(makeBadge(k.scope, scopeClass));
                nameRow.appendChild(makeBadge(enabledLabel, enabledClass));
                nameRow.appendChild(makeExpiryBadge(k.expires_at));
                info.appendChild(nameRow);

                var metaRow = document.createElement('div');
                metaRow.style.cssText = 'margin-top:var(--space-1);color:var(--muted);font-size:0.8125rem';
                var code = document.createElement('code');
                code.style.fontFamily = 'var(--font-mono)';
                code.textContent = k.display_token;
                metaRow.appendChild(code);
                metaRow.appendChild(document.createTextNode(' · Last used: ' + lastUsed));
                info.appendChild(metaRow);

                var actions = document.createElement('div');
                actions.style.cssText = 'display:flex;gap:var(--space-1);align-items:center;flex-shrink:0';
                var toggleBtn2 = document.createElement('button');
                toggleBtn2.className = 'btn btn-secondary btn-sm btn-toggle';
                toggleBtn2.dataset.id = k.token_id;
                toggleBtn2.textContent = toggleLabel;
                var deleteBtn2 = document.createElement('button');
                deleteBtn2.className = 'btn btn-danger btn-sm btn-delete';
                deleteBtn2.dataset.id = k.token_id;
                deleteBtn2.textContent = 'Delete';
                actions.appendChild(toggleBtn2);
                actions.appendChild(deleteBtn2);

                row.appendChild(info);
                row.appendChild(actions);
                keysList.appendChild(row);
            });
        }

        function makeBadge(text, cls) {
            var span = document.createElement('span');
            span.className = 'badge ' + cls;
            span.textContent = text;
            return span;
        }

        function makeExpiryBadge(expiresAt) {
            if (!expiresAt) return makeBadge('No expiry', 'badge-neutral');
            var exp = new Date(expiresAt);
            var now = new Date();
            if (exp <= now) return makeBadge('Expired', 'badge-danger');
            var days = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
            if (days <= 7) return makeBadge('Expires in ' + days + 'd', 'badge-warning');
            return makeBadge('Expires in ' + days + 'd', 'badge-neutral');
        }

        // ─── Create key ───
        createForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var name = document.getElementById('key-name').value.trim();
            if (!name) return;

            var scope = document.getElementById('key-scope').value;
            var expiresIn = document.getElementById('key-expiry').value || undefined;

            try {
                var resp = await fetch('/api/v1/account/tokens', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name, scope: scope, expires_in: expiresIn }),
                });

                if (!resp.ok) {
                    var err = await resp.json().catch(function () { return {}; });
                    showToast(err.error || 'Failed to create key', 'error');
                    return;
                }

                var data = await resp.json();

                // Show the full token once
                if (revealedToken) revealedToken.textContent = data.token;
                if (revealSection) revealSection.style.display = '';
                if (createSection) createSection.style.display = 'none';
                createForm.reset();

                showToast('API key created', 'success');
                loadKeys();
            } catch (err) {
                console.error('[api-keys] create error:', err);
                showToast('Network error', 'error');
            }
        });

        // ─── Copy token ───
        if (copyTokenBtn) {
            copyTokenBtn.addEventListener('click', function () {
                var token = revealedToken.textContent;
                navigator.clipboard.writeText(token).then(function () {
                    showToast('Copied to clipboard', 'success');
                }).catch(function () {
                    var range = document.createRange();
                    range.selectNodeContents(revealedToken);
                    window.getSelection().removeAllRanges();
                    window.getSelection().addRange(range);
                    showToast('Select All applied — press Ctrl+C', 'info');
                });
            });
        }

        // ─── Dismiss reveal ───
        if (dismissRevealBtn) {
            dismissRevealBtn.addEventListener('click', function () {
                if (revealSection) revealSection.style.display = 'none';
                if (revealedToken) revealedToken.textContent = '';
            });
        }

        // ─── Toggle create form ───
        if (createBtn) {
            createBtn.addEventListener('click', function () {
                var visible = createSection.style.display !== 'none';
                createSection.style.display = visible ? 'none' : '';
                if (!visible) {
                    var nameInput = document.getElementById('key-name');
                    if (nameInput) nameInput.focus();
                }
            });
        }

        if (cancelCreateBtn) {
            cancelCreateBtn.addEventListener('click', function () {
                if (createSection) createSection.style.display = 'none';
                createForm.reset();
            });
        }

        // ─── Delegate toggle/delete clicks ───
        keysList.addEventListener('click', async function (e) {
            var toggleBtn = e.target.closest('.btn-toggle');
            var deleteBtn = e.target.closest('.btn-delete');

            if (toggleBtn) {
                var id = toggleBtn.dataset.id;
                try {
                    var resp = await fetch('/api/v1/account/tokens/' + encodeURIComponent(id), {
                        method: 'POST',
                    });
                    if (!resp.ok) {
                        var err = await resp.json().catch(function () { return {}; });
                        showToast(err.error || 'Failed to toggle', 'error');
                        return;
                    }
                    showToast('Key toggled', 'success');
                    loadKeys();
                } catch (err) {
                    showToast('Network error', 'error');
                }
            }

            if (deleteBtn) {
                var did = deleteBtn.dataset.id;
                var row = deleteBtn.closest('.key-row');
                var dname = row ? (row.querySelector('strong')?.textContent || did) : did;
                if (!confirm('Delete API key "' + dname + '"?')) return;

                try {
                    var resp2 = await fetch('/api/v1/account/tokens/' + encodeURIComponent(did), {
                        method: 'DELETE',
                    });
                    if (!resp2.ok) {
                        var err2 = await resp2.json().catch(function () { return {}; });
                        showToast(err2.error || 'Failed to delete', 'error');
                        return;
                    }
                    showToast('Key deleted', 'success');
                    loadKeys();
                } catch (err) {
                    showToast('Network error', 'error');
                }
            }
        });

        // ─── Init ───
        loadKeys();
    }

    // ─── Helpers ───

    function timeAgo(dateStr) {
        var d = new Date(dateStr);
        var now = new Date();
        var secs = Math.floor((now - d) / 1000);
        if (secs < 60) return 'just now';
        var mins = Math.floor(secs / 60);
        if (mins < 60) return mins + 'm ago';
        var hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        var days = Math.floor(hrs / 24);
        return days + 'd ago';
    }

    /** Escape HTML to prevent XSS — all API values pass through this. */
    function esc(s) {
        var el = document.createElement('span');
        el.textContent = s || '';
        return el.innerHTML;
    }

    // ─── Auto-init: standalone page or settings modal ───
    // Run immediately if DOM elements exist (standalone page)
    initApiKeys();

    // Re-init when loaded inside settings modal
    document.addEventListener('settings-section-loaded', initApiKeys);
})();
