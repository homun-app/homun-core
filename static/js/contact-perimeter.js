// Homun — Contact detail: Access Perimeter
// Shows and manages the contact's isolation settings.
// Appended to the contact detail view after gateway overrides.

(function () {
    'use strict';

    const MEMORY_SCOPES = [
        { value: 'contact_only', label: 'Contact only', desc: 'Only conversations with this contact' },
        { value: 'namespace', label: 'Namespace', desc: 'Conversations + memories in allowed namespaces' },
        { value: 'profile', label: 'Full profile', desc: 'All memories for the active profile (less secure)' },
    ];

    const COMMON_TOOLS = ['vault', 'shell', 'file_read', 'file_write', 'file_edit', 'web_fetch', 'web_search', 'browser', 'spawn', 'cron'];

    async function loadPerimeter(contactId) {
        try {
            const res = await fetch(`/api/v1/contacts/${contactId}/perimeter`);
            if (res.ok) return await res.json();
        } catch (_) {}
        return null;
    }

    function renderPerimeterSection(contactId, container, perimeter) {
        const section = document.createElement('div');
        section.className = 'contact-section';
        section.id = 'perimeter-section';

        // Header
        const header = document.createElement('div');
        header.className = 'contact-section-header';
        const title = document.createElement('h3');
        title.textContent = 'Access Perimeter';
        header.appendChild(title);
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-ghost btn-sm';
        editBtn.textContent = 'Edit';
        header.appendChild(editBtn);
        section.appendChild(header);

        // Summary view — uses meta grid like Details section
        const summary = document.createElement('div');
        summary.className = 'contact-meta-grid';

        const namespaces = JSON.parse(perimeter.knowledge_namespaces || '["_public"]');
        const denied = JSON.parse(perimeter.tools_denied || '["vault"]');
        const scopeLabel = MEMORY_SCOPES.find(s => s.value === perimeter.memory_scope);

        addMetaItem(summary, 'Memory scope', scopeLabel ? scopeLabel.label : perimeter.memory_scope);
        addMetaItem(summary, 'Namespaces', namespaces.join(', ') || '_public');
        addMetaItem(summary, 'Denied tools', denied.join(', ') || 'none');
        addMetaItem(summary, 'See contacts', perimeter.can_see_contacts ? 'Yes' : 'No');
        addMetaItem(summary, 'See calendar', perimeter.can_see_calendar ? 'Yes' : 'No');
        section.appendChild(summary);

        // Edit form (hidden)
        const form = document.createElement('div');
        form.style.display = 'none';
        form.id = 'perimeter-edit-form';

        // Memory scope
        const scopeGroup = createFormGroup('Memory Scope');
        const scopeSelect = document.createElement('select');
        scopeSelect.className = 'input';
        MEMORY_SCOPES.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.value;
            opt.textContent = s.label + ' \u2014 ' + s.desc;
            if (s.value === perimeter.memory_scope) opt.selected = true;
            scopeSelect.appendChild(opt);
        });
        scopeGroup.appendChild(scopeSelect);
        form.appendChild(scopeGroup);

        // Namespaces
        const nsGroup = createFormGroup('Knowledge Namespaces');
        const nsInput = document.createElement('input');
        nsInput.className = 'input';
        nsInput.type = 'text';
        nsInput.placeholder = '_public, acme, shared';
        nsInput.value = namespaces.join(', ');
        nsGroup.appendChild(nsInput);
        const nsHint = document.createElement('div');
        nsHint.className = 'form-hint';
        nsHint.textContent = 'Comma-separated. _public is always included.';
        nsGroup.appendChild(nsHint);
        form.appendChild(nsGroup);

        // Denied tools
        const toolsGroup = createFormGroup('Denied Tools');
        const toolsContainer = document.createElement('div');
        toolsContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px';
        COMMON_TOOLS.forEach(tool => {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:0.8rem;cursor:pointer';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = tool;
            cb.checked = denied.includes(tool);
            label.appendChild(cb);
            label.appendChild(document.createTextNode(tool));
            toolsContainer.appendChild(label);
        });
        toolsGroup.appendChild(toolsContainer);
        form.appendChild(toolsGroup);

        // Toggles
        const toggleRow = document.createElement('div');
        toggleRow.style.cssText = 'display:flex;gap:16px;margin-top:8px';
        toggleRow.appendChild(createToggle('Can see contacts', 'perm-contacts', perimeter.can_see_contacts));
        toggleRow.appendChild(createToggle('Can see calendar', 'perm-calendar', perimeter.can_see_calendar));
        form.appendChild(toggleRow);

        // Save/Reset buttons
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary btn-sm';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const nsVal = nsInput.value.split(',').map(s => s.trim()).filter(Boolean);
            if (!nsVal.includes('_public')) nsVal.unshift('_public');

            const deniedVal = [];
            toolsContainer.querySelectorAll('input:checked').forEach(cb => deniedVal.push(cb.value));

            await fetch(`/api/v1/contacts/${contactId}/perimeter`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    memory_scope: scopeSelect.value,
                    knowledge_namespaces: nsVal,
                    tools_denied: deniedVal,
                    tools_allowed: [],
                    can_see_contacts: document.getElementById('perm-contacts').checked,
                    can_see_calendar: document.getElementById('perm-calendar').checked,
                }),
            });
            // Reload
            const updated = await loadPerimeter(contactId);
            if (updated) renderPerimeterSection(contactId, container, updated);
        });
        btnRow.appendChild(saveBtn);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn btn-secondary btn-sm';
        resetBtn.textContent = 'Reset to defaults';
        resetBtn.addEventListener('click', async () => {
            await fetch(`/api/v1/contacts/${contactId}/perimeter`, { method: 'DELETE' });
            const updated = await loadPerimeter(contactId);
            if (updated) renderPerimeterSection(contactId, container, updated);
        });
        btnRow.appendChild(resetBtn);
        form.appendChild(btnRow);
        section.appendChild(form);

        // Toggle edit form
        editBtn.addEventListener('click', () => {
            const isVisible = form.style.display !== 'none';
            form.style.display = isVisible ? 'none' : 'block';
            summary.style.display = isVisible ? 'block' : 'none';
            editBtn.textContent = isVisible ? 'Edit' : 'Cancel';
        });

        // Replace existing or append
        const existing = container.querySelector('#perimeter-section');
        if (existing) existing.replaceWith(section);
        else container.appendChild(section);
    }

    function addMetaItem(container, label, value) {
        const item = document.createElement('div');
        item.className = 'contact-meta-item';
        const lbl = document.createElement('span');
        lbl.className = 'contact-meta-label';
        lbl.textContent = label;
        item.appendChild(lbl);
        const val = document.createElement('span');
        val.className = 'contact-meta-value';
        val.textContent = value || '\u2014';
        item.appendChild(val);
        container.appendChild(item);
    }

    function createFormGroup(labelText) {
        const group = document.createElement('div');
        group.style.marginTop = '8px';
        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = labelText;
        group.appendChild(label);
        return group;
    }

    function createToggle(labelText, id, checked) {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:0.85rem;cursor:pointer';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = id;
        cb.checked = !!checked;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(labelText));
        return label;
    }

    // Listen for contact selection
    document.addEventListener('contact-selected', async (e) => {
        const { contactId, container } = e.detail;
        if (!contactId || !container) return;
        const perimeter = await loadPerimeter(contactId);
        if (perimeter) renderPerimeterSection(contactId, container, perimeter);
    });
})();
