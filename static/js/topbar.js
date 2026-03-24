/* ═══ TOPBAR — Avatar dropdown menu + profile selector ═══
   Single avatar button in top-right. Click opens dropdown with:
   - Profile switcher (radio-style with colored dots)
   - Settings links (Appearance, Settings)
   - Emergency Stop + Logout
   Profile persisted in localStorage. All pages subscribe to
   'profile-changed' CustomEvent. */

(function () {
    'use strict';

    var STORAGE_KEY = 'homun-active-profile';
    var activeProfile = null;
    var cachedProfiles = null;
    var dropdown = null;
    var lastAvatarBtn = null; // tracks which avatar button was clicked

    // ─── Public API ──────────────────────────────────────

    window.getActiveProfileSlug = function () {
        if (activeProfile) return activeProfile.slug;
        return localStorage.getItem(STORAGE_KEY) || '';
    };

    window.getActiveProfileId = function () {
        return activeProfile ? activeProfile.id : null;
    };

    window.getActiveProfile = function () {
        return activeProfile;
    };

    // ─── Init ────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    async function init() {
        // Bind all avatar buttons (main topbar + builder overlay)
        document.querySelectorAll('.topbar-avatar-btn').forEach(function (btn) {
            btn.addEventListener('click', toggleDropdown);
        });

        // Load profiles + restore last selection
        try {
            var res = await fetch('/api/v1/profiles');
            if (!res.ok) return;
            cachedProfiles = await res.json();
            if (!cachedProfiles.length) return;

            var saved = localStorage.getItem(STORAGE_KEY);
            var restored = saved ? cachedProfiles.find(function (p) { return p.slug === saved; }) : null;
            var initial = restored
                || cachedProfiles.find(function (p) { return p.is_default; })
                || cachedProfiles[0];

            setActiveProfile(initial, true);
        } catch (_) {
            // Profile selector is optional
        }
    }

    // ─── Profile management ──────────────────────────────

    function setActiveProfile(profile, emit) {
        activeProfile = profile;
        localStorage.setItem(STORAGE_KEY, profile.slug);
        if (emit) {
            document.dispatchEvent(new CustomEvent('profile-changed', {
                detail: { profile: profile },
            }));
        }
    }

    // ─── Dropdown ────────────────────────────────────────

    function toggleDropdown(e) {
        e.stopPropagation();
        if (dropdown) { closeDropdown(); return; }
        lastAvatarBtn = e.currentTarget;
        openDropdown();
    }

    function openDropdown() {
        var menu = document.createElement('div');
        menu.className = 'topbar-avatar-dropdown';

        // ── Header ──
        var header = document.createElement('div');
        header.className = 'topbar-avatar-dropdown-header';

        var avatarImg = document.createElement('img');
        avatarImg.src = '/api/v1/account/avatar';
        avatarImg.alt = '';
        avatarImg.onerror = function () {
            this.style.display = 'none';
            var fb = document.createElement('div');
            fb.className = 'topbar-dd-avatar-fallback';
            fb.appendChild(makeSvgIcon('M9 6a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 17c0-3.5 2.5-6 6-6s6 2.5 6 6', '0 0 18 18'));
            header.insertBefore(fb, header.firstChild);
        };
        header.appendChild(avatarImg);

        var info = document.createElement('div');
        var nameEl = document.createElement('div');
        nameEl.className = 'topbar-avatar-dropdown-name';
        nameEl.textContent = 'Homun';
        info.appendChild(nameEl);
        var subEl = document.createElement('div');
        subEl.className = 'topbar-avatar-dropdown-sub';
        subEl.textContent = activeProfile ? activeProfile.display_name : 'Default';
        info.appendChild(subEl);
        header.appendChild(info);
        menu.appendChild(header);

        // ── Profiles ──
        menu.appendChild(makeDivider());

        if (cachedProfiles && cachedProfiles.length > 0) {
            cachedProfiles.forEach(function (p) {
                var item = document.createElement('button');
                item.type = 'button';
                item.className = 'topbar-avatar-item'
                    + (activeProfile && p.id === activeProfile.id ? ' is-active' : '');

                var dot = document.createElement('span');
                dot.className = 'topbar-dd-profile-dot';
                dot.style.background = p.color || '#3B82F6';
                item.appendChild(dot);

                item.appendChild(document.createTextNode(
                    p.display_name + (p.is_default ? ' (default)' : '')
                ));

                item.addEventListener('click', function () {
                    setActiveProfile(p, true);
                    closeDropdown();
                });
                menu.appendChild(item);
            });

            // "Go to Profiles" link
            var profileLink = makeItemWithSvg(
                'M7 3l5 6-5 6',
                'Vai ai profili'
            );
            profileLink.addEventListener('click', function () {
                closeDropdown();
                window.location.href = '/profiles';
            });
            menu.appendChild(profileLink);
        }

        // ── Settings links ──
        menu.appendChild(makeDivider());

        var appearanceItem = makeItemWithSvg(
            'M9 1.5a7.5 7.5 0 110 15V1.5z',
            'Personalizzazione',
            'M9 1.5a7.5 7.5 0 100 15 7.5 7.5 0 000-15z'
        );
        appearanceItem.addEventListener('click', function () {
            closeDropdown();
            if (window.openSettingsModal) window.openSettingsModal('appearance');
        });
        menu.appendChild(appearanceItem);

        var settingsItem = makeItemWithSvg(
            'M9 11.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
            'Impostazioni',
            'M14.7 11.1a1.2 1.2 0 00.24 1.32l.04.04a1.44 1.44 0 11-2.04 2.04l-.04-.04a1.2 1.2 0 00-2.04.84v.12a1.44 1.44 0 01-2.88 0v-.06a1.2 1.2 0 00-.78-1.08 1.2 1.2 0 00-1.32.24l-.04.04a1.44 1.44 0 11-2.04-2.04l.04-.04a1.2 1.2 0 00-.84-2.04h-.12a1.44 1.44 0 010-2.88h.06a1.2 1.2 0 001.08-.78 1.2 1.2 0 00-.24-1.32l-.04-.04a1.44 1.44 0 112.04-2.04l.04.04a1.2 1.2 0 002.04-.84V2.88a1.44 1.44 0 012.88 0v.06a1.2 1.2 0 00.72 1.08 1.2 1.2 0 001.32-.24l.04-.04a1.44 1.44 0 112.04 2.04l-.04.04a1.2 1.2 0 00.84 2.04h.12a1.44 1.44 0 010 2.88h-.06a1.2 1.2 0 00-1.08.72z'
        );
        settingsItem.addEventListener('click', function () {
            closeDropdown();
            if (window.openSettingsModal) window.openSettingsModal('setup');
        });
        menu.appendChild(settingsItem);

        // ── Actions ──
        menu.appendChild(makeDivider());

        var estopItem = makeItemWithSvg(
            'M6.5 6.5h5v5h-5z',
            'Emergency Stop',
            'M6 1h6l5 5v6l-5 5H6l-5-5V6z'
        );
        estopItem.classList.add('is-danger');
        estopItem.addEventListener('click', function () {
            closeDropdown();
            var modal = document.getElementById('estop-modal');
            if (modal) modal.style.display = 'flex';
        });
        menu.appendChild(estopItem);

        var logoutItem = makeItemWithSvg(
            'M6 15H3.5A1.5 1.5 0 012 13.5v-9A1.5 1.5 0 013.5 3H6M12 12l4-3-4-3M16 9H7',
            'Logout'
        );
        logoutItem.classList.add('is-danger');
        logoutItem.addEventListener('click', function () {
            closeDropdown();
            fetch('/api/auth/logout', { method: 'POST' }).then(function () {
                window.location.href = '/login';
            });
        });
        menu.appendChild(logoutItem);

        // ── Position below avatar button ──
        var btn = lastAvatarBtn || document.querySelector('.topbar-avatar-btn');
        if (!btn) return;
        var rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 8) + 'px';
        menu.style.right = (window.innerWidth - rect.right) + 'px';

        document.body.appendChild(menu);
        dropdown = menu;

        setTimeout(function () {
            document.addEventListener('click', onOutsideClick);
            document.addEventListener('keydown', onEscape);
        }, 0);
    }

    function closeDropdown() {
        if (dropdown) { dropdown.remove(); dropdown = null; }
        document.removeEventListener('click', onOutsideClick);
        document.removeEventListener('keydown', onEscape);
    }

    function onOutsideClick(e) {
        if (dropdown && !dropdown.contains(e.target)) {
            closeDropdown();
        }
    }

    function onEscape(e) {
        if (e.key === 'Escape') closeDropdown();
    }

    // ─── Helpers ─────────────────────────────────────────

    function makeDivider() {
        var d = document.createElement('div');
        d.className = 'topbar-avatar-divider';
        return d;
    }

    /** Create an SVG icon element from path data (safe: no user input). */
    function makeSvgIcon(pathD, viewBox, extraPathD) {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', viewBox || '0 0 18 18');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        if (extraPathD) {
            var p2 = document.createElementNS(ns, 'path');
            p2.setAttribute('d', extraPathD);
            svg.appendChild(p2);
        }
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', pathD);
        svg.appendChild(path);
        return svg;
    }

    /** Create a menu item button with SVG icon paths and label. */
    function makeItemWithSvg(pathD, label, extraPathD) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'topbar-avatar-item';
        var icon = makeSvgIcon(pathD, '0 0 18 18', extraPathD);
        btn.appendChild(icon);
        btn.appendChild(document.createTextNode(label));
        return btn;
    }
})();
