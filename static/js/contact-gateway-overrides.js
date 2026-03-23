// Homun — Contact detail: Gateway Profile Overrides
// Shows and manages per-gateway profile overrides for a contact.
// Appended to the contact detail view when a contact is selected.

(function () {
    'use strict';

    let cachedGateways = null;
    let cachedProfiles = null;

    async function loadGateways() {
        if (cachedGateways) return cachedGateways;
        try {
            const res = await fetch('/api/v1/gateways');
            if (res.ok) cachedGateways = await res.json();
        } catch (_) {}
        return cachedGateways || [];
    }

    async function loadProfiles() {
        if (cachedProfiles) return cachedProfiles;
        try {
            const res = await fetch('/api/v1/profiles');
            if (res.ok) cachedProfiles = await res.json();
        } catch (_) {}
        return cachedProfiles || [];
    }

    async function loadOverrides(contactId) {
        try {
            const res = await fetch(`/api/v1/contacts/${contactId}/gateway-overrides`);
            if (res.ok) return await res.json();
        } catch (_) {}
        return [];
    }

    function profileName(profiles, profileId) {
        const p = profiles.find(pr => pr.id === profileId);
        return p ? (p.avatar_emoji || '\uD83D\uDC64') + ' ' + p.display_name : 'ID ' + profileId;
    }

    function gatewayName(gateways, gatewayId) {
        const g = gateways.find(gw => gw.id === gatewayId);
        return g ? g.name : 'Gateway ' + gatewayId;
    }

    /// Render the gateway overrides section into the contact detail.
    async function renderOverridesSection(contactId, container) {
        const [gateways, profiles, overrides] = await Promise.all([
            loadGateways(),
            loadProfiles(),
            loadOverrides(contactId),
        ]);

        // Don't show section if no gateways configured
        if (gateways.length === 0) return;

        const section = document.createElement('div');
        section.className = 'detail-section';
        section.id = 'gateway-overrides-section';

        // Header
        const header = document.createElement('div');
        header.className = 'detail-section-header';
        const title = document.createElement('h3');
        title.textContent = 'Gateway Profile Overrides';
        header.appendChild(title);
        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-secondary btn-xs';
        addBtn.textContent = '+ Add';
        header.appendChild(addBtn);
        section.appendChild(header);

        // Existing overrides
        if (overrides.length > 0) {
            const list = document.createElement('div');
            list.className = 'item-list';
            overrides.forEach(ov => {
                const row = document.createElement('div');
                row.className = 'item-row';
                row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)';

                const info = document.createElement('div');
                info.style.fontSize = '0.875rem';
                const gwLabel = document.createElement('strong');
                gwLabel.textContent = gatewayName(gateways, ov.gateway_id);
                info.appendChild(gwLabel);
                const arrow = document.createTextNode(' \u2192 ');
                info.appendChild(arrow);
                const profLabel = document.createElement('span');
                profLabel.textContent = profileName(profiles, ov.profile_id);
                info.appendChild(profLabel);
                row.appendChild(info);

                const removeBtn = document.createElement('button');
                removeBtn.className = 'btn btn-danger btn-xs';
                removeBtn.textContent = '\u00D7';
                removeBtn.addEventListener('click', async () => {
                    await fetch(`/api/v1/contacts/${contactId}/gateway-overrides/${ov.gateway_id}`, {
                        method: 'DELETE',
                    });
                    renderOverridesSection(contactId, container);
                });
                row.appendChild(removeBtn);

                list.appendChild(row);
            });
            section.appendChild(list);
        } else {
            const empty = document.createElement('p');
            empty.style.cssText = 'color:var(--muted);font-size:0.8rem;margin:8px 0';
            empty.textContent = 'No overrides — uses contact default profile on all gateways.';
            section.appendChild(empty);
        }

        // Add form (hidden until + Add clicked)
        const form = document.createElement('div');
        form.style.cssText = 'display:none;margin-top:8px';

        const formRow = document.createElement('div');
        formRow.style.cssText = 'display:flex;gap:8px;align-items:flex-end';

        // Gateway select
        const gwGroup = document.createElement('div');
        gwGroup.style.flex = '1';
        const gwLabel = document.createElement('label');
        gwLabel.textContent = 'Gateway';
        gwLabel.style.cssText = 'font-size:0.75rem;color:var(--muted);display:block;margin-bottom:2px';
        const gwSelect = document.createElement('select');
        gwSelect.className = 'input';
        // Only show gateways that don't already have an override
        const usedGwIds = new Set(overrides.map(o => o.gateway_id));
        gateways.filter(g => !usedGwIds.has(g.id)).forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = g.name + ' (' + g.channel_type + ')';
            gwSelect.appendChild(opt);
        });
        gwGroup.appendChild(gwLabel);
        gwGroup.appendChild(gwSelect);
        formRow.appendChild(gwGroup);

        // Profile select
        const profGroup = document.createElement('div');
        profGroup.style.flex = '1';
        const profSelectLabel = document.createElement('label');
        profSelectLabel.textContent = 'Profile';
        profSelectLabel.style.cssText = 'font-size:0.75rem;color:var(--muted);display:block;margin-bottom:2px';
        const profSelect = document.createElement('select');
        profSelect.className = 'input';
        profiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = (p.avatar_emoji || '\uD83D\uDC64') + ' ' + p.display_name;
            profSelect.appendChild(opt);
        });
        profGroup.appendChild(profSelectLabel);
        profGroup.appendChild(profSelect);
        formRow.appendChild(profGroup);

        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary btn-sm';
        saveBtn.textContent = 'Save';
        saveBtn.style.marginBottom = '1px';
        saveBtn.addEventListener('click', async () => {
            const gwId = parseInt(gwSelect.value, 10);
            const profId = parseInt(profSelect.value, 10);
            if (!gwId || !profId) return;
            await fetch(`/api/v1/contacts/${contactId}/gateway-overrides`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gateway_id: gwId, profile_id: profId }),
            });
            renderOverridesSection(contactId, container);
        });
        formRow.appendChild(saveBtn);
        form.appendChild(formRow);
        section.appendChild(form);

        // Toggle add form
        addBtn.addEventListener('click', () => {
            const isVisible = form.style.display !== 'none';
            form.style.display = isVisible ? 'none' : 'block';
            addBtn.textContent = isVisible ? '+ Add' : 'Cancel';
        });

        // Replace existing section or append
        const existing = container.querySelector('#gateway-overrides-section');
        if (existing) existing.replaceWith(section);
        else container.appendChild(section);
    }

    // Listen for contact selection events from contacts.js
    // contacts.js dispatches 'contact-selected' with {detail: {contactId, container}}
    document.addEventListener('contact-selected', (e) => {
        const { contactId, container } = e.detail;
        if (contactId && container) {
            renderOverridesSection(contactId, container);
        }
    });

    // Also hook into the existing detail rendering via MutationObserver on the detail panel
    // This catches the case where contacts.js renders detail without dispatching an event
    const detailPanel = document.querySelector('.detail-panel, .split-detail');
    if (detailPanel) {
        const observer = new MutationObserver(() => {
            // Look for a rendered contact detail with data-contact-id
            const el = detailPanel.querySelector('[data-contact-id]');
            if (el) {
                const contactId = parseInt(el.dataset.contactId, 10);
                if (contactId) renderOverridesSection(contactId, el);
            }
        });
        observer.observe(detailPanel, { childList: true, subtree: true });
    }
})();
