// Homun — Account page: Your Gateways section
// Manages gateway instances (CRUD) via /api/v1/gateways

(function () {
    'use strict';

    const CHANNEL_ICONS = {
        telegram: '\u2708\uFE0F',
        discord: '\uD83C\uDFAE',
        whatsapp: '\uD83D\uDCF1',
        slack: '\uD83D\uDCAC',
        email: '\u2709\uFE0F',
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
        const icon = CHANNEL_ICONS[gw.channel_type] || '\uD83D\uDD0C';
        const profileName = gw.default_profile || 'Default';

        const card = document.createElement('div');
        card.className = 'provider-card';
        card.dataset.id = gw.id;
        card.style.cursor = 'pointer';

        // Header row
        const header = document.createElement('div');
        header.className = 'provider-card-header';

        const titleWrap = document.createElement('div');
        titleWrap.className = 'provider-card-title';

        const iconSpan = document.createElement('span');
        iconSpan.style.fontSize = '1.25rem';
        iconSpan.textContent = icon;
        titleWrap.appendChild(iconSpan);

        const nameSpan = document.createElement('span');
        nameSpan.textContent = gw.name;
        titleWrap.appendChild(nameSpan);

        header.appendChild(titleWrap);

        const badge = document.createElement('span');
        badge.className = gw.enabled ? 'badge badge-success' : 'badge badge-neutral';
        badge.style.fontSize = '0.7rem';
        badge.textContent = gw.enabled ? 'Active' : 'Disabled';
        header.appendChild(badge);

        card.appendChild(header);

        // Details row
        const details = document.createElement('div');
        details.style.cssText = 'color:var(--muted);font-size:0.8rem;margin-top:4px';
        details.textContent = `${gw.channel_type} \u00B7 Profile: ${profileName} \u00B7 ${gw.response_mode}`;
        card.appendChild(details);

        card.addEventListener('click', () => openModal(gw));
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
})();
