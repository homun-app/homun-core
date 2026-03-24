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
        const nsLabels = namespaces.map(ns => {
            if (ns === '_public') return '_public';
            if (ns === 'contact_' + contactId) return 'own';
            return ns;
        });
        addMetaItem(summary, 'Namespaces', nsLabels.join(', ') || '_public');
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

        // Namespaces — tag-style UI with contact auto-namespace + custom
        const nsGroup = createFormGroup('Knowledge Namespaces');
        const nsTagContainer = document.createElement('div');
        nsTagContainer.className = 'perm-ns-tags';
        nsTagContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px';

        // Auto-namespace for this contact (always present, not removable)
        const ownNs = 'contact_' + contactId;
        const autoTag = document.createElement('span');
        autoTag.className = 'badge';
        autoTag.textContent = 'Own (' + ownNs + ')';
        autoTag.title = 'Auto-generated, always included';
        autoTag.style.opacity = '0.6';
        nsTagContainer.appendChild(autoTag);

        // _public always present
        const pubTag = document.createElement('span');
        pubTag.className = 'badge';
        pubTag.textContent = '_public';
        pubTag.title = 'Always included';
        pubTag.style.opacity = '0.6';
        nsTagContainer.appendChild(pubTag);

        // Editable custom namespaces (exclude auto ones)
        const customNs = namespaces.filter(ns => ns !== '_public' && ns !== ownNs);
        customNs.forEach(ns => {
            nsTagContainer.appendChild(createNsTag(ns, nsTagContainer));
        });

        // Add button + input for new custom namespace
        const addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:4px;align-items:center;margin-top:6px';
        const nsAddInput = document.createElement('input');
        nsAddInput.className = 'input';
        nsAddInput.type = 'text';
        nsAddInput.placeholder = 'custom namespace';
        nsAddInput.style.cssText = 'font-size:0.8rem;max-width:160px';
        addRow.appendChild(nsAddInput);
        const nsAddBtn = document.createElement('button');
        nsAddBtn.className = 'btn btn-sm';
        nsAddBtn.type = 'button';
        nsAddBtn.textContent = 'Add';
        nsAddBtn.addEventListener('click', () => {
            const val = nsAddInput.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
            if (val && val !== '_public' && val !== '_private' && val !== ownNs) {
                // Check not already added
                const existing = nsTagContainer.querySelectorAll('.perm-ns-tag');
                let found = false;
                existing.forEach(t => { if (t.dataset.ns === val) found = true; });
                if (!found) {
                    nsTagContainer.appendChild(createNsTag(val, nsTagContainer));
                }
            }
            nsAddInput.value = '';
        });
        addRow.appendChild(nsAddBtn);
        nsGroup.appendChild(nsTagContainer);
        nsGroup.appendChild(addRow);

        const nsHint = document.createElement('div');
        nsHint.className = 'form-hint';
        nsHint.textContent = 'Own namespace and _public are always included. Add custom namespaces for shared documents.';
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
            // Collect namespaces: own + _public (always) + custom tags
            const ownNs = 'contact_' + contactId;
            const nsVal = ['_public', ownNs];
            nsTagContainer.querySelectorAll('.perm-ns-tag').forEach(t => {
                if (t.dataset.ns && !nsVal.includes(t.dataset.ns)) nsVal.push(t.dataset.ns);
            });

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

    /** Create a removable namespace tag element. */
    function createNsTag(ns, container) {
        const tag = document.createElement('span');
        tag.className = 'badge perm-ns-tag';
        tag.dataset.ns = ns;
        tag.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;gap:4px';
        tag.textContent = ns;
        const x = document.createElement('span');
        x.textContent = '\u00d7';
        x.style.cssText = 'font-weight:bold;opacity:0.6';
        tag.appendChild(x);
        tag.title = 'Click to remove';
        tag.addEventListener('click', () => tag.remove());
        return tag;
    }

    // Listen for contact selection
    document.addEventListener('contact-selected', async (e) => {
        const { contactId, container } = e.detail;
        if (!contactId || !container) return;
        const perimeter = await loadPerimeter(contactId);
        if (perimeter) renderPerimeterSection(contactId, container, perimeter);
    });
})();
