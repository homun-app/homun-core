// ═══ Settings Modal ═══
// Manus-style overlay modal with sidebar nav + lazy-loaded content sections.
// Each section's HTML is fetched from /api/v1/settings/section/{name}
// and its JS is loaded dynamically on first visit.
// Note: innerHTML is used intentionally here for trusted server-rendered HTML
// fragments from our own API endpoints (same-origin, authenticated).

(function () {
    'use strict';

    // ─── Section registry ───
    var SECTIONS = [
        { id: 'account',     label: 'Account',           group: null,       icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="3.5"/><path d="M3 17c0-3.5 2.5-6 6-6s6 2.5 6 6"/></svg>', scripts: ['account.js', 'account-gateways.js'] },
        { id: 'setup',       label: 'Model & Providers', group: 'General',  icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="2.5"/><path d="M14.5 11a1.5 1.5 0 00.3 1.65l.05.05a1.82 1.82 0 01-1.29 3.11 1.82 1.82 0 01-1.29-.54l-.05-.05A1.5 1.5 0 0010 15.5v.14A1.82 1.82 0 018.18 17.5h0A1.82 1.82 0 016.36 15.64V15.5a1.5 1.5 0 00-1-1.42 1.5 1.5 0 00-1.65.3l-.05.05a1.82 1.82 0 01-2.58-2.58l.05-.05A1.5 1.5 0 001.42 10H1.36A1.82 1.82 0 01-.5 8.18h0A1.82 1.82 0 011.36 6.36H1.5a1.5 1.5 0 001.42-1"/></svg>', scripts: ['embedding-loader.js', 'setup.js'] },
        { id: 'appearance',  label: 'Appearance',        group: 'General',  icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="7.5"/><path d="M9 1.5a7.5 7.5 0 000 15V1.5z"/></svg>', scripts: ['accent-utils.js', 'appearance.js'] },
        { id: 'channels',    label: 'Channels',          group: 'General',  icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h14M2 9h14M2 14h8"/></svg>', scripts: ['channels.js'] },
        { id: 'browser',     label: 'Browser',           group: 'General',  icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="14" height="14" rx="2"/><line x1="2" y1="6" x2="16" y2="6"/><circle cx="4.5" cy="4" r="0.5" fill="currentColor"/><circle cx="6.5" cy="4" r="0.5" fill="currentColor"/></svg>', scripts: ['setup.js'] },
        { id: 'vault',       label: 'Vault',             group: 'Security', icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="12" height="9" rx="2"/><path d="M6 7V5a3 3 0 016 0v2"/><circle cx="9" cy="12" r="1"/></svg>', scripts: ['vault.js'] },
        { id: 'api-keys',    label: 'API Keys',          group: 'Security', icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l5 5-7 7-5.5 1 1-5.5 7-7z"/><path d="M10 4l4 4"/></svg>', scripts: ['api-keys.js'] },
        { id: 'approvals',   label: 'Approvals',         group: 'Security', icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5L2.5 4.5v4c0 4.5 3 7.5 6.5 9 3.5-1.5 6.5-4.5 6.5-9v-4L9 1.5z"/><path d="M6.5 9l2 2 3.5-3.5"/></svg>', scripts: ['approvals.js'] },
        { id: 'file-access', label: 'File Access',       group: 'Security', icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 14.5V3.5A1.5 1.5 0 013.5 2h4l2 2H14.5A1.5 1.5 0 0116 5.5v9a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 012 14.5z"/></svg>', scripts: ['file-access.js'] },
        { id: 'shell',       label: 'Shell',             group: 'Security', icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="14" height="14" rx="2"/><path d="M5 7l3 2.5L5 12"/><line x1="10" y1="12" x2="13" y2="12"/></svg>', scripts: ['shell.js'] },
        { id: 'sandbox',     label: 'Sandbox',           group: 'Security', icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="14" height="14" rx="2"/><rect x="5" y="5" width="8" height="8" rx="1"/></svg>', scripts: ['sandbox.js'] },
        { id: 'maintenance', label: 'Database',          group: 'System',   icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="9" cy="4" rx="6.5" ry="2.5"/><path d="M2.5 4v5c0 1.38 2.91 2.5 6.5 2.5S15.5 10.38 15.5 9V4"/><path d="M2.5 9v5c0 1.38 2.91 2.5 6.5 2.5s6.5-1.12 6.5-2.5V9"/></svg>', scripts: ['maintenance.js'] },
        { id: 'logs',        label: 'Logs',              group: 'System',   icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h12v12H3z"/><path d="M6 7h6M6 10h4"/></svg>', scripts: ['logs.js'] },
        { id: 'usage',       label: 'Usage',             group: 'Info',     icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 16V6l4-4h8l2 2v12H2z"/><path d="M6 2v4H2"/></svg>', scripts: ['dash-usage.js'] },
        { id: 'health',      label: 'System Health',     group: 'Info',     icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9h2l2-4 2 8 2-4h4"/></svg>', scripts: ['dashboard.js'] },
        { id: 'history',     label: 'History',            group: 'Info',     icon: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="7"/><path d="M9 5v4l3 2"/></svg>', scripts: ['dashboard.js'] },
    ];

    var overlayEl = null;
    var bodyEl = null;
    var titleEl = null;
    var currentSection = null;
    var loadedScripts = {};

    // ─── Build modal DOM ───
    function createModal() {
        overlayEl = document.createElement('div');
        overlayEl.className = 'settings-modal-overlay';

        // Build nav items
        var navItems = '';
        var lastGroup = null;
        SECTIONS.forEach(function (s) {
            if (s.group && s.group !== lastGroup) {
                navItems += '<div class="settings-modal-nav-group">' + escapeHtml(s.group) + '</div>';
                lastGroup = s.group;
            }
            navItems += '<button type="button" class="settings-modal-nav-item" data-section="' + s.id + '">' +
                s.icon + '<span>' + escapeHtml(s.label) + '</span></button>';
        });

        // Assemble modal (trusted static HTML, no user input)
        overlayEl.innerHTML =  // safe: static template with escaped labels
            '<div class="settings-modal">' +
            '<nav class="settings-modal-nav">' +
                '<div class="settings-modal-nav-header">' +
                    '<img src="/static/img/homun.png" alt="homun" class="settings-modal-nav-logo settings-logo-light">' +
                    '<img src="/static/img/homun_white.png" alt="homun" class="settings-modal-nav-logo settings-logo-dark" style="display:none">' +
                '</div>' +
                navItems +
            '</nav>' +
            '<div class="settings-modal-content">' +
                '<div class="settings-modal-header">' +
                    '<h2 class="settings-modal-title"></h2>' +
                    '<button type="button" class="settings-modal-close" title="Close">' +
                        '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="5" x2="13" y2="13"/><line x1="13" y1="5" x2="5" y2="13"/></svg>' +
                    '</button>' +
                '</div>' +
                '<div class="settings-modal-body">' +
                    '<div class="settings-modal-loading">Loading\u2026</div>' +
                '</div>' +
            '</div>' +
        '</div>';

        document.body.appendChild(overlayEl);
        bodyEl = overlayEl.querySelector('.settings-modal-body');
        titleEl = overlayEl.querySelector('.settings-modal-title');

        // Close on backdrop click
        overlayEl.addEventListener('click', function (e) {
            if (e.target === overlayEl) closeSettings();
        });

        // Close button
        overlayEl.querySelector('.settings-modal-close').addEventListener('click', closeSettings);

        // Nav item clicks
        overlayEl.querySelectorAll('.settings-modal-nav-item').forEach(function (item) {
            item.addEventListener('click', function () {
                var id = this.getAttribute('data-section');
                if (id) loadSection(id);
            });
        });

        // Escape key
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && overlayEl && overlayEl.classList.contains('is-open')) {
                closeSettings();
            }
        });
    }

    /** Minimal HTML escaping for label text. */
    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ─── Open / Close ───
    function openSettings(sectionId) {
        if (!overlayEl) createModal();

        // Apply correct logo for dark mode
        var isDark = document.documentElement.classList.contains('dark');
        var lightLogo = overlayEl.querySelector('.settings-logo-light');
        var darkLogo = overlayEl.querySelector('.settings-logo-dark');
        if (lightLogo) lightLogo.style.display = isDark ? 'none' : '';
        if (darkLogo) darkLogo.style.display = isDark ? '' : 'none';

        overlayEl.classList.add('is-open');
        document.body.classList.add('settings-modal-open');
        loadSection(sectionId || 'account');

        // Update URL hash
        history.replaceState(null, '', '#settings/' + (sectionId || 'account'));
    }

    function closeSettings() {
        if (!overlayEl) return;

        // Fire unload event for cleanup (e.g. logs SSE)
        document.dispatchEvent(new Event('settings-section-unload'));

        overlayEl.classList.remove('is-open');
        document.body.classList.remove('settings-modal-open');
        currentSection = null;

        // Clean URL hash
        if (location.hash.startsWith('#settings')) {
            history.replaceState(null, '', location.pathname + location.search);
        }
    }

    // ─── Load section via AJAX ───
    async function loadSection(sectionId) {
        if (sectionId === currentSection) return;

        var section = SECTIONS.find(function (s) { return s.id === sectionId; });
        if (!section) return;

        // Fire unload for previous section
        if (currentSection) {
            document.dispatchEvent(new Event('settings-section-unload'));
        }
        currentSection = sectionId;

        // Update nav active state
        overlayEl.querySelectorAll('.settings-modal-nav-item').forEach(function (item) {
            item.classList.toggle('is-active', item.getAttribute('data-section') === sectionId);
        });

        // Update title
        titleEl.textContent = section.label;

        // Show loading
        bodyEl.textContent = '';
        var loadingDiv = document.createElement('div');
        loadingDiv.className = 'settings-modal-loading';
        loadingDiv.textContent = 'Loading\u2026';
        bodyEl.appendChild(loadingDiv);

        // Fetch section HTML from trusted server endpoint
        try {
            var res = await fetch('/api/v1/settings/section/' + encodeURIComponent(sectionId));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var html = await res.text();

            // Verify we're still on the same section
            if (currentSection !== sectionId) return;

            // Inject trusted server-rendered HTML
            bodyEl.innerHTML = html; // safe: same-origin authenticated API

            // Load required scripts
            for (var i = 0; i < section.scripts.length; i++) {
                await loadScript(section.scripts[i]);
            }

            // Notify scripts that DOM is ready (include section ID for filtering)
            document.dispatchEvent(new CustomEvent('settings-section-loaded', { detail: { section: sectionId } }));

            // Update URL hash
            history.replaceState(null, '', '#settings/' + sectionId);
        } catch (err) {
            if (currentSection === sectionId) {
                bodyEl.textContent = '';
                var errDiv = document.createElement('div');
                errDiv.className = 'settings-modal-loading';
                errDiv.style.color = 'var(--err)';
                errDiv.textContent = 'Failed to load section: ' + err.message;
                bodyEl.appendChild(errDiv);
            }
        }
    }

    // Scripts that must reload fresh each time (IIFEs that bind to DOM at load time)
    var RELOAD_SCRIPTS = { 'setup.js': true, 'embedding-loader.js': true };

    // ─── Dynamic script loading ───
    function loadScript(filename) {
        // Scripts with complex IIFEs need fresh reload each time
        if (RELOAD_SCRIPTS[filename]) {
            // Remove old script tag if exists
            var old = document.querySelector('script[data-settings-script="' + filename + '"]');
            if (old) old.remove();
            delete loadedScripts[filename];
        }
        if (loadedScripts[filename]) return Promise.resolve();
        return new Promise(function (resolve) {
            var script = document.createElement('script');
            script.src = '/static/js/' + filename + '?t=' + Date.now();
            script.setAttribute('data-settings-script', filename);
            script.onload = function () {
                loadedScripts[filename] = true;
                resolve();
            };
            script.onerror = function () {
                console.error('[Settings] Failed to load script:', filename);
                resolve(); // Don't block on script errors
            };
            document.head.appendChild(script);
        });
    }

    // ─── Auto-open from URL hash ───
    function checkHash() {
        var hash = location.hash;
        if (hash.startsWith('#settings/')) {
            var sectionId = hash.replace('#settings/', '');
            openSettings(sectionId);
        }
    }

    document.addEventListener('DOMContentLoaded', checkHash);
    window.addEventListener('hashchange', checkHash);

    // ─── Global API ───
    window.openSettingsModal = openSettings;
    window.closeSettingsModal = closeSettings;
})();
