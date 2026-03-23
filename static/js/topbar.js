/* ═══ TOPBAR — Global profile selector + event bus ═══
   Single source of truth for active profile. All pages subscribe
   to the 'profile-changed' CustomEvent instead of maintaining
   their own selector. Profile persisted in localStorage. */

(function () {
    'use strict';

    const STORAGE_KEY = 'homun-active-profile';

    /** Currently active profile object (full API shape). */
    let activeProfile = null;

    /** Cached profiles list to avoid re-fetching on every dropdown open. */
    let cachedProfiles = null;

    /** Reference to open dropdown (if any). */
    let dropdown = null;

    // ─── Public API ────────────────────────────────────────

    /** Return active profile slug (used by page filters as ?profile=slug).
     *  Falls back to localStorage if the async init hasn't completed yet. */
    window.getActiveProfileSlug = function () {
        if (activeProfile) return activeProfile.slug;
        return localStorage.getItem(STORAGE_KEY) || '';
    };

    /** Return active profile ID (UUID, used by chat WebSocket). */
    window.getActiveProfileId = function () {
        return activeProfile ? activeProfile.id : null;
    };

    /** Return full active profile object. */
    window.getActiveProfile = function () {
        return activeProfile;
    };

    // ─── Init ──────────────────────────────────────────────

    // Init immediately if DOM already ready, otherwise wait
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    async function init() {
        const pill = document.getElementById('global-profile-pill');
        if (!pill) return;

        pill.addEventListener('click', toggleDropdown);

        // Load profiles + restore last selection
        try {
            const res = await fetch('/api/v1/profiles');
            if (!res.ok) return;
            cachedProfiles = await res.json();
            if (!cachedProfiles.length) return;

            // Restore from localStorage or use default
            const saved = localStorage.getItem(STORAGE_KEY);
            const restored = saved
                ? cachedProfiles.find(p => p.slug === saved)
                : null;
            const initial = restored
                || cachedProfiles.find(p => p.is_default)
                || cachedProfiles[0];

            // Emit the event so page-specific JS reloads with the correct profile.
            // Pages load data at DOMContentLoaded but topbar's async fetch may finish
            // after that — the event triggers a reload with the right profile filter.
            setActiveProfile(initial, /* emit */ true);
        } catch (_) {
            /* profile selector is optional — degrade gracefully */
        }
    }

    // ─── Profile management ────────────────────────────────

    function setActiveProfile(profile, emit = true) {
        activeProfile = profile;
        localStorage.setItem(STORAGE_KEY, profile.slug);
        updatePillDisplay(profile);

        if (emit) {
            document.dispatchEvent(new CustomEvent('profile-changed', {
                detail: { profile },
            }));
        }
    }

    function updatePillDisplay(profile) {
        const dot = document.getElementById('global-profile-dot');
        const name = document.getElementById('global-profile-name');
        if (dot) dot.style.background = profile.color || '#3B82F6';
        if (name) name.textContent = profile.display_name || 'Default';
    }

    // ─── Dropdown ──────────────────────────────────────────

    function toggleDropdown(e) {
        e.stopPropagation();
        if (dropdown) { closeDropdown(); return; }
        openDropdown();
    }

    async function openDropdown() {
        // Refresh profiles if cache is stale
        if (!cachedProfiles) {
            try {
                const res = await fetch('/api/v1/profiles');
                if (!res.ok) return;
                cachedProfiles = await res.json();
            } catch (_) { return; }
        }

        const menu = document.createElement('div');
        menu.className = 'topbar-profile-dropdown';

        cachedProfiles.forEach(p => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'topbar-profile-option'
                + (activeProfile && p.id === activeProfile.id ? ' is-active' : '');

            // Colored dot + name
            const dot = document.createElement('span');
            dot.className = 'topbar-option-dot';
            dot.style.background = p.color || '#3B82F6';
            btn.appendChild(dot);

            const label = document.createTextNode(p.display_name + (p.is_default ? ' (default)' : ''));
            btn.appendChild(label);

            btn.addEventListener('click', () => {
                setActiveProfile(p);
                closeDropdown();
            });
            menu.appendChild(btn);
        });

        // Separator + "Go to Profiles" link
        const sep = document.createElement('div');
        sep.className = 'topbar-profile-sep';
        menu.appendChild(sep);

        const link = document.createElement('a');
        link.href = '/profiles';
        link.className = 'topbar-profile-link';
        link.textContent = 'Go to Profiles';
        link.addEventListener('click', () => closeDropdown());
        menu.appendChild(link);

        // Position below pill (fixed, like chat-tools-dropdown)
        const pill = document.getElementById('global-profile-pill');
        if (!pill) return;
        const rect = pill.getBoundingClientRect();
        menu.style.top = (rect.bottom + 6) + 'px';
        menu.style.right = (window.innerWidth - rect.right) + 'px';

        document.body.appendChild(menu);
        dropdown = menu;

        // Close on outside click (deferred so this click doesn't trigger it)
        setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
    }

    function closeDropdown() {
        if (dropdown) { dropdown.remove(); dropdown = null; }
        document.removeEventListener('click', onOutsideClick);
    }

    function onOutsideClick(e) {
        if (dropdown && !dropdown.contains(e.target)) {
            closeDropdown();
        }
    }
})();
