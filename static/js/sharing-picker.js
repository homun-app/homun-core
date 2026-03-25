/**
 * SharingPicker — Reusable modal for sharing MCP servers and skills with contacts.
 *
 * For MCP: shows contact multi-select + per-contact tool checkboxes.
 * For Skills: shows contact multi-select only (no tool granularity).
 *
 * Uses the same visual pattern as the knowledge visibility picker.
 */
(function () {
    'use strict';

    var PICKER_ID = 'sharing-picker-backdrop';
    var _contacts = null;
    var _tools = null; // cached MCP tools for current resource

    // ─── Public API ────────────────────────────────────

    window.SharingPicker = {
        /**
         * Open the sharing picker modal.
         * @param {Object} opts
         * @param {string} opts.title - Modal title (e.g. 'Share "notion"')
         * @param {string} opts.resourceType - 'mcp' or 'skill'
         * @param {string} opts.resourceId - server name or skill name
         * @param {boolean} opts.showToolPicker - show per-contact tool selection
         * @param {function} opts.onSave - callback after save completes
         */
        open: async function (opts) {
            close();
            var contacts = await loadContacts();
            if (!contacts.length) {
                alert('No contacts found. Add contacts first.');
                return;
            }
            var tools = opts.showToolPicker ? await loadTools(opts.resourceId) : [];
            var existing = await loadExistingGrants(opts.resourceType, opts.resourceId);
            buildModal(opts, contacts, tools, existing);
        }
    };

    // ─── Data Loading ──────────────────────────────────

    async function loadContacts() {
        if (_contacts) return _contacts;
        try {
            var r = await fetch('/api/v1/contacts');
            if (!r.ok) return [];
            var d = await r.json();
            _contacts = d.contacts || d || [];
            return _contacts;
        } catch (_) { return []; }
    }

    async function loadTools(serverName) {
        if (!window.McpLoader) return [];
        var result = await McpLoader.discoverTools(serverName);
        return result.ok ? result.tools : [];
    }

    /** Load existing shared_resource + access grants for this resource. */
    async function loadExistingGrants(resourceType, resourceId) {
        try {
            var r = await fetch('/api/v1/sharing/resources');
            if (!r.ok) return { resourceDbId: null, grants: [] };
            var data = await r.json();
            var resources = data.resources || data || [];
            var res = resources.find(function (x) {
                return x.resource_type === resourceType && x.resource_id === resourceId;
            });
            if (!res) return { resourceDbId: null, grants: [] };

            var r2 = await fetch('/api/v1/sharing/resources/' + res.id);
            if (!r2.ok) return { resourceDbId: res.id, grants: [] };
            var d2 = await r2.json();
            return { resourceDbId: res.id, grants: d2.access || d2 || [] };
        } catch (_) { return { resourceDbId: null, grants: [] }; }
    }

    // ─── Modal Builder ─────────────────────────────────

    function buildModal(opts, contacts, tools, existing) {
        // State: Map<contact_id, {selected, permission, allowed_tools: Set}>
        var state = new Map();
        contacts.forEach(function (c) { state.set(c.id, { selected: false, permission: 'read', allowed_tools: new Set() }); });

        // Initialize from existing grants
        (existing.grants || []).forEach(function (g) {
            var s = state.get(g.contact_id);
            if (!s) return;
            s.selected = true;
            s.permission = g.permission || 'read';
            try {
                var scope = JSON.parse(g.scope_json || '{}');
                if (Array.isArray(scope.allowed_tools)) {
                    scope.allowed_tools.forEach(function (t) { s.allowed_tools.add(t); });
                }
            } catch (_) { /* invalid scope_json, ignore */ }
        });

        // Track which contact is expanded for tool selection
        var expandedContactId = null;

        // Backdrop
        var backdrop = document.createElement('div');
        backdrop.className = 'knowledge-vis-backdrop';
        backdrop.id = PICKER_ID;

        // Modal
        var modal = document.createElement('div');
        modal.className = 'knowledge-vis-modal';
        if (opts.showToolPicker) modal.style.maxHeight = 'min(80vh, 620px)';

        // Header
        var header = document.createElement('div');
        header.className = 'knowledge-vis-header';
        var title = document.createElement('h3');
        title.textContent = opts.title || 'Share resource';
        header.appendChild(title);
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'knowledge-vis-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', close);
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // Search
        var searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'knowledge-vis-search';
        searchInput.placeholder = 'Search contacts\u2026';
        searchInput.autocomplete = 'off';
        modal.appendChild(searchInput);

        // Body
        var body = document.createElement('div');
        body.className = 'knowledge-vis-body';
        modal.appendChild(body);

        // Footer
        var footer = document.createElement('div');
        footer.className = 'knowledge-vis-footer';
        var summary = document.createElement('span');
        summary.className = 'knowledge-vis-summary';
        footer.appendChild(summary);
        var doneBtn = document.createElement('button');
        doneBtn.type = 'button';
        doneBtn.className = 'btn btn-primary btn-sm';
        doneBtn.textContent = 'Save';
        footer.appendChild(doneBtn);
        modal.appendChild(footer);

        // ─── Render ────────────────────────────────────

        function countSelected() {
            var n = 0;
            state.forEach(function (s) { if (s.selected) n++; });
            return n;
        }

        function updateSummary() {
            var n = countSelected();
            summary.textContent = n === 0 ? 'Private (no one)' : n + ' contact' + (n > 1 ? 's' : '') + ' selected';
        }

        function toggleContact(contactId) {
            var s = state.get(contactId);
            if (!s) return;
            s.selected = !s.selected;
            if (s.selected && tools.length && s.allowed_tools.size === 0) {
                // Default: grant all tools when first selecting a contact
                tools.forEach(function (t) { s.allowed_tools.add(t.name); });
            }
            renderBody(searchInput.value);
            updateSummary();
        }

        function toggleTool(contactId, toolName) {
            var s = state.get(contactId);
            if (!s) return;
            if (s.allowed_tools.has(toolName)) {
                s.allowed_tools.delete(toolName);
            } else {
                s.allowed_tools.add(toolName);
            }
            renderBody(searchInput.value);
        }

        function toggleAllTools(contactId) {
            var s = state.get(contactId);
            if (!s) return;
            if (s.allowed_tools.size === tools.length) {
                s.allowed_tools.clear();
            } else {
                tools.forEach(function (t) { s.allowed_tools.add(t.name); });
            }
            renderBody(searchInput.value);
        }

        function expandContact(contactId) {
            expandedContactId = expandedContactId === contactId ? null : contactId;
            renderBody(searchInput.value);
        }

        function renderBody(filter) {
            body.textContent = '';
            var q = (filter || '').toLowerCase();
            var filtered = contacts.filter(function (c) {
                return !q || c.name.toLowerCase().indexOf(q) !== -1;
            });

            if (filtered.length === 0 && q) {
                var empty = document.createElement('div');
                empty.className = 'knowledge-vis-empty';
                empty.textContent = 'No contacts matching \u201c' + filter + '\u201d';
                body.appendChild(empty);
                return;
            }

            filtered.forEach(function (c) {
                var s = state.get(c.id);
                if (!s) return;

                // Contact row
                var item = document.createElement('button');
                item.type = 'button';
                item.className = 'knowledge-vis-option' + (s.selected ? ' is-current' : '');

                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = s.selected;
                cb.style.cssText = 'pointer-events:none;margin:0';
                item.appendChild(cb);

                var nameEl = document.createElement('span');
                nameEl.className = 'knowledge-vis-option-name';
                nameEl.textContent = c.name;
                item.appendChild(nameEl);

                // Tool count hint (for MCP with tool picker)
                if (opts.showToolPicker && s.selected && tools.length) {
                    var hint = document.createElement('span');
                    hint.className = 'knowledge-vis-option-desc';
                    hint.textContent = s.allowed_tools.size + '/' + tools.length + ' tools';
                    item.appendChild(hint);
                }

                item.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (!s.selected) {
                        toggleContact(c.id);
                        if (opts.showToolPicker && tools.length) expandedContactId = c.id;
                        renderBody(searchInput.value);
                    } else if (opts.showToolPicker && tools.length) {
                        expandContact(c.id);
                    } else {
                        toggleContact(c.id);
                    }
                });

                // Deselect button for selected contacts
                if (s.selected) {
                    var removeBtn = document.createElement('span');
                    removeBtn.className = 'knowledge-vis-option-check';
                    removeBtn.textContent = '\u00d7';
                    removeBtn.title = 'Remove access';
                    removeBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        toggleContact(c.id);
                    });
                    item.appendChild(removeBtn);
                }

                body.appendChild(item);

                // Expandable tool panel (under selected contact)
                if (opts.showToolPicker && s.selected && expandedContactId === c.id && tools.length) {
                    var panel = document.createElement('div');
                    panel.className = 'sharing-tools-panel';

                    // Select all / none toggle
                    var toggleAll = document.createElement('button');
                    toggleAll.type = 'button';
                    toggleAll.className = 'sharing-tool-item sharing-tool-toggle';
                    toggleAll.textContent = s.allowed_tools.size === tools.length ? 'Deselect all' : 'Select all';
                    toggleAll.addEventListener('click', function (e) {
                        e.stopPropagation();
                        toggleAllTools(c.id);
                    });
                    panel.appendChild(toggleAll);

                    tools.forEach(function (tool) {
                        var row = document.createElement('label');
                        row.className = 'sharing-tool-item';

                        var tcb = document.createElement('input');
                        tcb.type = 'checkbox';
                        tcb.checked = s.allowed_tools.has(tool.name);
                        tcb.addEventListener('change', function (e) {
                            e.stopPropagation();
                            toggleTool(c.id, tool.name);
                        });
                        row.appendChild(tcb);

                        var tn = document.createElement('span');
                        tn.className = 'sharing-tool-name';
                        tn.textContent = tool.name;
                        row.appendChild(tn);

                        if (tool.description) {
                            var td = document.createElement('span');
                            td.className = 'sharing-tool-desc';
                            td.textContent = tool.description;
                            row.appendChild(td);
                        }

                        panel.appendChild(row);
                    });

                    body.appendChild(panel);
                }
            });
        }

        // ─── Save ──────────────────────────────────────

        doneBtn.addEventListener('click', async function () {
            doneBtn.disabled = true;
            doneBtn.textContent = 'Saving\u2026';
            try {
                await saveGrants(opts, existing, state, tools.length > 0);
                if (opts.onSave) opts.onSave();
            } catch (e) {
                console.error('Sharing save failed:', e);
            }
            close();
        });

        // ─── Events ────────────────────────────────────

        searchInput.addEventListener('input', function () { renderBody(this.value); });
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', onEscape);

        renderBody('');
        updateSummary();
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        searchInput.focus();
    }

    // ─── Save Logic ────────────────────────────────────

    async function saveGrants(opts, existing, state, hasTools) {
        var resourceDbId = existing.resourceDbId;

        // Collect contacts that should have access
        var grants = [];
        state.forEach(function (s, contactId) {
            if (s.selected) {
                var scopeJson = '{}';
                if (hasTools && s.allowed_tools.size > 0) {
                    scopeJson = JSON.stringify({ allowed_tools: Array.from(s.allowed_tools) });
                }
                grants.push({ contact_id: contactId, permission: s.permission, scope_json: scopeJson });
            }
        });

        // Create the shared resource if it doesn't exist yet
        if (!resourceDbId && grants.length > 0) {
            var profileId = window.getActiveProfileId ? window.getActiveProfileId() : 1;
            var r = await fetch('/api/v1/sharing/resources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    resource_type: opts.resourceType,
                    resource_id: opts.resourceId,
                    owner_profile_id: profileId,
                    description: opts.title || opts.resourceId
                })
            });
            if (r.ok) {
                var d = await r.json();
                resourceDbId = d.id;
            }
        }

        if (!resourceDbId) return;

        // Determine adds, updates, and removes
        var existingMap = new Map();
        (existing.grants || []).forEach(function (g) { existingMap.set(g.contact_id, g); });

        // Grant/update access for selected contacts (API upserts)
        for (var i = 0; i < grants.length; i++) {
            var g = grants[i];
            await fetch('/api/v1/sharing/resources/' + resourceDbId + '/access', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(g)
            });
        }

        // Revoke access for deselected contacts
        var selectedIds = new Set(grants.map(function (g) { return g.contact_id; }));
        for (var entry of existingMap) {
            if (!selectedIds.has(entry[0])) {
                await fetch('/api/v1/sharing/resources/' + resourceDbId + '/access/' + entry[0], {
                    method: 'DELETE'
                });
            }
        }
    }

    // ─── Helpers ────────────────────────────────────────

    function close() {
        var el = document.getElementById(PICKER_ID);
        if (el) el.remove();
        document.removeEventListener('keydown', onEscape);
    }

    function onEscape(e) {
        if (e.key === 'Escape') close();
    }

})();
