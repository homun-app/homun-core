/**
 * Sidebar — collapsible icon↔expanded navigation.
 * Collapsed: 56px icons only with tooltips.
 * Expanded: 280px with icon + text labels.
 * Toggle: click pin button or hover-to-peek.
 */
(function () {
    'use strict';

    var sidebar = document.getElementById('sidebar');
    var toggleBtn = document.getElementById('sidebar-toggle');
    if (!sidebar || !toggleBtn) return;

    var STORAGE_KEY = 'homun-sidebar-pinned';
    var HOVER_EXPAND_DELAY = 200;
    var HOVER_COLLAPSE_DELAY = 400;
    var expandTimer = null;
    var collapseTimer = null;

    // Restore pinned state from localStorage
    var pinned = localStorage.getItem(STORAGE_KEY) === 'true';
    if (pinned) {
        sidebar.classList.add('is-expanded', 'is-pinned');
    }

    // Toggle pinned state on button click
    toggleBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        pinned = !pinned;
        localStorage.setItem(STORAGE_KEY, pinned ? 'true' : 'false');
        sidebar.classList.toggle('is-pinned', pinned);
        sidebar.classList.toggle('is-expanded', pinned);
    });

    // Hover-to-peek (only when not pinned)
    sidebar.addEventListener('mouseenter', function () {
        if (pinned) return;
        clearTimeout(collapseTimer);
        expandTimer = setTimeout(function () {
            sidebar.classList.add('is-expanded');
        }, HOVER_EXPAND_DELAY);
    });

    sidebar.addEventListener('mouseleave', function () {
        if (pinned) return;
        clearTimeout(expandTimer);
        collapseTimer = setTimeout(function () {
            sidebar.classList.remove('is-expanded');
        }, HOVER_COLLAPSE_DELAY);
    });

    // Escape collapses (if not pinned)
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !pinned && sidebar.classList.contains('is-expanded')) {
            sidebar.classList.remove('is-expanded');
        }
    });

    // Load recent sessions into sidebar (safe DOM construction)
    var recentEl = document.getElementById('nav-recent-sessions');
    if (recentEl) {
        fetch('/api/v1/sessions?limit=5')
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (sessions) {
                if (!sessions || !sessions.length) return;
                var frag = document.createDocumentFragment();
                sessions.forEach(function (s) {
                    var label = s.title || s.session_key || 'Untitled';
                    if (label.length > 30) label = label.slice(0, 30) + '\u2026';
                    var a = document.createElement('a');
                    a.href = '/chat?c=' + encodeURIComponent(s.session_key);
                    a.className = 'nav-recent-item';
                    a.title = label;
                    var dot = document.createElement('span');
                    dot.className = 'nav-recent-dot';
                    var text = document.createElement('span');
                    text.className = 'nav-label';
                    text.textContent = label;
                    a.appendChild(dot);
                    a.appendChild(text);
                    frag.appendChild(a);
                });
                recentEl.appendChild(frag);
            })
            .catch(function () { /* silent */ });
    }
})();
