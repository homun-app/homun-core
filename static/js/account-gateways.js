// Homun — Account page: Your Gateways section
// Manages gateway instances (CRUD) via /api/v1/gateways

(function () {
    'use strict';

    function initGateways() {

    // SVG icons matching the Channels section for visual consistency
    var CHANNEL_SVGS = {
        telegram: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 2.5L1.5 8l5 2m9-7.5L6.5 10m9-7.5l-3 13-5.5-5.5"/><path d="M6.5 10v4.5l2.5-2.5"/></svg>',
        discord: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3C5 3 3 3.5 2 5c-1.5 3-.5 7.5 1 9.5.5.5 1.5 1.5 3 1.5s2-1 3-1 1.5 1 3 1 2.5-1 3-1.5c1.5-2 2.5-6.5 1-9.5-1-1.5-3-2-4.5-2"/><circle cx="6.5" cy="10" r="1"/><circle cx="11.5" cy="10" r="1"/></svg>',
        whatsapp: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="1" width="10" height="16" rx="2"/><line x1="9" y1="14" x2="9" y2="14"/></svg>',
        slack: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M9 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/><path d="M15 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M9 15a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
        email: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="16" height="12" rx="2"/><path d="M1 5l8 5 8-5"/></svg>',
        web: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="7.5"/><path d="M1.5 9h15"/></svg>',
    };

    const grid = document.getElementById('gateways-grid');
    const emptyState = document.getElementById('gateways-empty');
    const countBadge = document.getElementById('gateways-count');
    const addBtn = document.getElementById('btn-add-gateway');
    const modal = document.getElementById('gateway-modal');
    const form = document.getElementById('gateway-form');
    const deleteBtn = document.getElementById('btn-delete-gateway');

    if (!grid || !modal) return;

    let gateways = [];
    let profiles = [];

    // ─── Load ───

    async function loadGateways() {
        try {
            const res = await fetch('/api/v1/gateways');
            if (!res.ok) return;
            gateways = await res.json();
            render();
        } catch (e) {
            console.error('[Gateways] Failed to load:', e);
        }
    }

    async function loadProfiles() {
        try {
            const res = await fetch('/api/v1/profiles');
            if (!res.ok) return;
            profiles = await res.json();
        } catch (_) {}
    }

    // ─── Render ───

    function createCard(gw) {
        var svgIcon = CHANNEL_SVGS[gw.channel_type] || CHANNEL_SVGS.web;
        var profileName = gw.default_profile || 'Default';

        var card = document.createElement('div');
        card.className = 'provider-card channel-card';
        card.dataset.id = gw.id;
        card.style.cursor = 'pointer';

        // Header row — same structure as channel cards
        var header = document.createElement('div');
        header.className = 'provider-card-header';

        var info = document.createElement('div');
        info.className = 'provider-card-info';

        // Parse SVG with proper namespace so it renders in HTML context
        var iconWrap = document.createElement('span');
        iconWrap.className = 'channel-icon';
        var svgWithNs = svgIcon.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
        var parser = new DOMParser();
        var svgDoc = parser.parseFromString(svgWithNs, 'image/svg+xml');
        var svgEl = svgDoc.documentElement;
        iconWrap.appendChild(document.adoptNode(svgEl));
        info.appendChild(iconWrap);

        var nameSpan = document.createElement('span');
        nameSpan.className = 'provider-card-name';
        nameSpan.textContent = gw.name;
        info.appendChild(nameSpan);

        header.appendChild(info);

        var actions = document.createElement('div');
        actions.className = 'provider-card-actions';
        var badge = document.createElement('span');
        badge.className = gw.enabled ? 'badge badge-success' : 'badge badge-neutral';
        badge.textContent = gw.enabled ? 'Active' : 'Disabled';
        actions.appendChild(badge);
        header.appendChild(actions);

        card.appendChild(header);

        // Description row
        var desc = document.createElement('div');
        desc.className = 'provider-card-desc';
        desc.textContent = gw.channel_type + ' \u00B7 Profile: ' + profileName + ' \u00B7 ' + gw.response_mode;
        card.appendChild(desc);

        card.addEventListener('click', function () { openModal(gw); });
        return card;
    }

    function render() {
        countBadge.textContent = gateways.length;

        // Clear existing cards but preserve empty state element
        while (grid.firstChild) grid.removeChild(grid.firstChild);

        if (gateways.length === 0) {
            emptyState.style.display = 'block';
            grid.appendChild(emptyState);
            return;
        }

        emptyState.style.display = 'none';
        gateways.forEach(gw => grid.appendChild(createCard(gw)));
    }

    // ─── Modal ───

    function populateProfileSelect(selectedSlug) {
        const select = document.getElementById('gw-profile');
        select.textContent = ''; // clear
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Default';
        select.appendChild(defaultOpt);

        profiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.slug;
            opt.textContent = (p.avatar_emoji || '\uD83D\uDC64') + ' ' + p.display_name;
            if (p.slug === selectedSlug) opt.selected = true;
            select.appendChild(opt);
        });
    }

    function openModal(gw) {
        const isEdit = !!gw;
        document.getElementById('gw-modal-title').textContent = isEdit ? 'Edit Gateway' : 'Add Gateway';
        document.getElementById('gw-id').value = isEdit ? gw.id : '';
        document.getElementById('gw-name').value = isEdit ? gw.name : '';
        document.getElementById('gw-channel-type').value = isEdit ? gw.channel_type : 'telegram';
        document.getElementById('gw-channel-type').disabled = isEdit;
        document.getElementById('gw-token').value = '';
        document.getElementById('gw-token').placeholder = isEdit ? 'Leave empty to keep existing' : 'Bot token or API key';
        document.getElementById('gw-response-mode').value = isEdit ? (gw.response_mode || 'automatic') : 'automatic';
        deleteBtn.style.display = isEdit ? '' : 'none';

        populateProfileSelect(isEdit ? gw.default_profile : '');
        // Move modal to body to escape settings modal stacking context
        if (modal.parentElement !== document.body) {
            document.body.appendChild(modal);
        }
        modal.classList.add('open');
    }

    function closeModal() {
        modal.classList.remove('open');
    }

    // ─── CRUD ───

    async function saveGateway(e) {
        e.preventDefault();
        const id = document.getElementById('gw-id').value;
        const isEdit = !!id;

        const payload = {
            name: document.getElementById('gw-name').value.trim(),
            channel_type: document.getElementById('gw-channel-type').value,
            default_profile: document.getElementById('gw-profile').value,
            response_mode: document.getElementById('gw-response-mode').value,
        };

        const token = document.getElementById('gw-token').value.trim();
        if (token) payload.token = token;

        try {
            const url = isEdit ? `/api/v1/gateways/${id}` : '/api/v1/gateways';
            const method = isEdit ? 'PUT' : 'POST';
            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                alert(err.error || 'Failed to save gateway');
                return;
            }

            closeModal();
            await loadGateways();
        } catch (err) {
            alert('Network error: ' + err.message);
        }
    }

    async function deleteGateway() {
        const id = document.getElementById('gw-id').value;
        if (!id) return;
        if (!confirm('Delete this gateway? This cannot be undone.')) return;

        try {
            const res = await fetch(`/api/v1/gateways/${id}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                alert(err.error || 'Failed to delete');
                return;
            }
            closeModal();
            await loadGateways();
        } catch (err) {
            alert('Network error: ' + err.message);
        }
    }

    // ─── Events ───

    addBtn.addEventListener('click', () => openModal(null));
    form.addEventListener('submit', saveGateway);
    deleteBtn.addEventListener('click', deleteGateway);

    modal.querySelectorAll('.gw-modal-close, .modal-backdrop').forEach(el => {
        el.addEventListener('click', closeModal);
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });

    // ─── Init ───

    loadProfiles().then(() => loadGateways());

    } // end initGateways

    initGateways();
    document.addEventListener('settings-section-loaded', initGateways);
})();
