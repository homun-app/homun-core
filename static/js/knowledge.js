// Knowledge Base page — upload, search, list sources
// KIX-2: contact-based namespace assignment with searchable contact picker

/** Cached contacts list for namespace selectors. */
var _cachedContacts = null;
/** Current selected namespace for upload. */
var _selectedNamespace = '_private';

document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('profile-changed', () => { loadStats(); loadSources(); });
    loadStats();
    loadContacts().then(() => loadSources());
    setupUpload();
    setupSearch();
    setupFolderIndex();
    setupVisibilityPicker();
});

/** Get the current profile filter slug from global topbar (empty = all). */
function getKnowledgeProfileFilter() {
    return window.getActiveProfileSlug ? window.getActiveProfileSlug() : '';
}

/** Get the selected namespace for upload (first one if multi). */
function getSelectedNamespace() {
    if (Array.isArray(_selectedNamespace)) return _selectedNamespace[0] || '_private';
    return _selectedNamespace;
}

/** Get all selected namespaces as array. */
function getSelectedNamespaces() {
    if (Array.isArray(_selectedNamespace)) return _selectedNamespace;
    return [_selectedNamespace];
}

/** Format a selection (string or array) for display on the trigger button. */
function selectionLabel(sel) {
    if (!sel) return 'Only me';
    if (!Array.isArray(sel)) return namespaceLabel(sel);
    if (sel.length === 1) return namespaceLabel(sel[0]);
    // Multi: show first name + count
    return namespaceLabel(sel[0]) + ' +' + (sel.length - 1);
}

// ─── Contacts Cache ──────────────────────────────────

/** Load contacts list for namespace selectors. */
async function loadContacts() {
    try {
        var resp = await fetch('/api/v1/contacts');
        if (!resp.ok) return;
        var data = await resp.json();
        _cachedContacts = data.contacts || data || [];
    } catch (_) {
        _cachedContacts = [];
    }
}

/** Resolve a namespace string to a human-readable label. */
function namespaceLabel(ns) {
    if (!ns || ns === '_private') return 'Only me';
    if (ns === '_public') return 'All contacts';
    if (ns.startsWith('contact_') && _cachedContacts) {
        var cid = parseInt(ns.replace('contact_', ''), 10);
        var c = _cachedContacts.find(function (x) { return x.id === cid; });
        if (c) return c.name;
    }
    return ns;
}

// ─── Visibility Picker (searchable contact picker) ───

function setupVisibilityPicker() {
    var btn = document.getElementById('upload-namespace-btn');
    if (!btn) return;
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        openVisibilityPicker(btn, function (sel) {
            _selectedNamespace = sel;
            btn.textContent = selectionLabel(sel);
        });
    });
}

/** Open the visibility picker modal with multi-select for contacts. */
function openVisibilityPicker(anchor, onSelect) {
    closeVisibilityPicker();

    // Parse current selection into a set
    var selected = new Set();
    if (Array.isArray(_selectedNamespace)) {
        _selectedNamespace.forEach(function (ns) { selected.add(ns); });
    } else {
        selected.add(_selectedNamespace);
    }

    var backdrop = document.createElement('div');
    backdrop.className = 'knowledge-vis-backdrop';
    backdrop.id = 'knowledge-vis-picker';

    var modal = document.createElement('div');
    modal.className = 'knowledge-vis-modal';

    // Header
    var header = document.createElement('div');
    header.className = 'knowledge-vis-header';
    var title = document.createElement('h3');
    title.textContent = 'Visible to';
    header.appendChild(title);
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'knowledge-vis-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', closeVisibilityPicker);
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

    // Footer with Done button + selection summary
    var footer = document.createElement('div');
    footer.className = 'knowledge-vis-footer';
    var summary = document.createElement('span');
    summary.className = 'knowledge-vis-summary';
    footer.appendChild(summary);
    var doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'btn btn-primary btn-sm';
    doneBtn.textContent = 'Done';
    footer.appendChild(doneBtn);
    modal.appendChild(footer);

    function updateSummary() {
        if (selected.has('_private')) {
            summary.textContent = 'Only you';
        } else if (selected.has('_public')) {
            summary.textContent = 'All contacts';
        } else {
            var count = selected.size;
            summary.textContent = count === 0 ? 'No one selected' : count + ' contact' + (count > 1 ? 's' : '') + ' selected';
        }
    }

    /** Select a fixed option (exclusive — clears contacts). */
    function selectFixed(ns) {
        selected.clear();
        selected.add(ns);
        renderOptions(searchInput.value);
        updateSummary();
    }

    /** Toggle a contact (clears fixed options). */
    function toggleContact(ns) {
        selected.delete('_private');
        selected.delete('_public');
        if (selected.has(ns)) {
            selected.delete(ns);
            if (selected.size === 0) selected.add('_private'); // fallback
        } else {
            selected.add(ns);
        }
        renderOptions(searchInput.value);
        updateSummary();
    }

    function renderOptions(filter) {
        body.textContent = '';
        var q = (filter || '').toLowerCase();

        // Fixed options (radio-style)
        [
            { ns: '_private', label: 'Only me', desc: 'Only you can see these documents' },
            { ns: '_public', label: 'All contacts', desc: 'Visible to every contact' },
        ].forEach(function (opt) {
            if (q && opt.label.toLowerCase().indexOf(q) === -1) return;
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'knowledge-vis-option' + (selected.has(opt.ns) ? ' is-current' : '');
            var nameEl = document.createElement('span');
            nameEl.className = 'knowledge-vis-option-name';
            nameEl.textContent = opt.label;
            item.appendChild(nameEl);
            var descEl = document.createElement('span');
            descEl.className = 'knowledge-vis-option-desc';
            descEl.textContent = opt.desc;
            item.appendChild(descEl);
            if (selected.has(opt.ns)) {
                var check = document.createElement('span');
                check.className = 'knowledge-vis-option-check';
                check.textContent = '\u2713';
                item.appendChild(check);
            }
            item.addEventListener('click', function () { selectFixed(opt.ns); });
            body.appendChild(item);
        });

        // Contact options (multi-select with checkboxes)
        if (_cachedContacts && _cachedContacts.length > 0) {
            var filtered = _cachedContacts.filter(function (c) {
                return !q || c.name.toLowerCase().indexOf(q) !== -1;
            });
            if (filtered.length > 0) {
                var groupLabel = document.createElement('div');
                groupLabel.className = 'knowledge-vis-group';
                groupLabel.textContent = 'Contacts';
                body.appendChild(groupLabel);
            }
            filtered.forEach(function (c) {
                var ns = 'contact_' + c.id;
                var item = document.createElement('button');
                item.type = 'button';
                item.className = 'knowledge-vis-option' + (selected.has(ns) ? ' is-current' : '');

                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = selected.has(ns);
                cb.style.cssText = 'pointer-events:none;margin:0';
                item.appendChild(cb);

                var nameEl = document.createElement('span');
                nameEl.className = 'knowledge-vis-option-name';
                nameEl.textContent = c.name;
                item.appendChild(nameEl);

                item.addEventListener('click', function () { toggleContact(ns); });
                body.appendChild(item);
            });

            if (filtered.length === 0 && q) {
                var empty = document.createElement('div');
                empty.className = 'knowledge-vis-empty';
                empty.textContent = 'No contacts matching \u201c' + filter + '\u201d';
                body.appendChild(empty);
            }
        }
    }

    searchInput.addEventListener('input', function () {
        renderOptions(this.value);
    });

    doneBtn.addEventListener('click', function () {
        // Convert selection to namespace(s)
        var arr = Array.from(selected);
        if (arr.length === 1) {
            onSelect(arr[0]);
        } else {
            onSelect(arr);
        }
        closeVisibilityPicker();
    });

    renderOptions('');
    updateSummary();
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    searchInput.focus();

    backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) closeVisibilityPicker();
    });
    document.addEventListener('keydown', onPickerEscape);
}

function closeVisibilityPicker() {
    var el = document.getElementById('knowledge-vis-picker');
    if (el) el.remove();
    document.removeEventListener('keydown', onPickerEscape);
}

function onPickerEscape(e) {
    if (e.key === 'Escape') closeVisibilityPicker();
}

/**
 * When a document is shared with multiple contacts, the source gets the
 * first contact's namespace. For each additional contact, we add that
 * namespace to their perimeter so they can see the document too.
 */
async function ensureSharedPerimeters(namespaces) {
    if (!Array.isArray(namespaces) || namespaces.length <= 1) return;
    var primaryNs = namespaces[0]; // the source's namespace
    // For each additional contact, add primaryNs to their perimeter
    for (var i = 1; i < namespaces.length; i++) {
        var ns = namespaces[i];
        if (!ns.startsWith('contact_')) continue;
        var cid = parseInt(ns.replace('contact_', ''), 10);
        if (isNaN(cid)) continue;
        try {
            // Load current perimeter
            var res = await fetch('/api/v1/contacts/' + cid + '/perimeter');
            if (!res.ok) continue;
            var perimeter = await res.json();
            var current = JSON.parse(perimeter.knowledge_namespaces || '["_public"]');
            // Add the primary namespace if not already present
            if (!current.includes(primaryNs)) {
                current.push(primaryNs);
                await fetch('/api/v1/contacts/' + cid + '/perimeter', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ knowledge_namespaces: current }),
                });
            }
        } catch (_) { /* best effort */ }
    }
}

// ─── Stats ────────────────────────────────────────────

async function loadStats() {
    try {
        const resp = await fetch('/api/v1/knowledge/stats');
        if (!resp.ok) return;
        const data = await resp.json();
        document.getElementById('stat-sources').textContent = data.source_count ?? '0';
        document.getElementById('stat-chunks').textContent = data.chunk_count ?? '0';
        document.getElementById('stat-vectors').textContent = data.vector_count ?? '0';
    } catch (e) {
        console.warn('Failed to load knowledge stats:', e);
    }
}

// ─── Sources List ─────────────────────────────────────

async function loadSources() {
    const container = document.getElementById('sources-list');
    try {
        const pf = getKnowledgeProfileFilter();
        const profileParam = pf ? '?profile=' + encodeURIComponent(pf) : '';
        const resp = await fetch('/api/v1/knowledge/sources' + profileParam);
        if (!resp.ok) throw new Error('Failed to load sources');
        const data = await resp.json();
        const sources = data.sources || [];

        container.textContent = '';

        if (sources.length === 0) {
            const p = document.createElement('p');
            p.className = 'empty-state';
            p.textContent = 'No documents indexed yet. Upload files above to get started.';
            container.appendChild(p);
            return;
        }

        const table = document.createElement('table');
        table.className = 'data-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        ['File', 'Type', 'Visible to', 'Chunks', 'Size', 'Status', 'Date', ''].forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        sources.forEach(s => {
            const tr = document.createElement('tr');

            const tdFile = document.createElement('td');
            tdFile.textContent = s.file_name;
            tdFile.title = s.file_path;
            tr.appendChild(tdFile);

            const tdType = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = s.doc_type;
            tdType.appendChild(badge);
            tr.appendChild(tdType);

            // Visible to — clickable pill that opens the same picker
            const tdNs = document.createElement('td');
            const nsBtn = document.createElement('button');
            nsBtn.type = 'button';
            nsBtn.className = 'knowledge-vis-inline-btn';
            nsBtn.textContent = namespaceLabel(s.namespace || '_private');
            nsBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                openVisibilityPicker(nsBtn, function (sel) {
                    // Source has one namespace; use first from selection
                    var ns = Array.isArray(sel) ? sel[0] : sel;
                    updateSourceNamespace(s.id, ns);
                    nsBtn.textContent = namespaceLabel(ns);
                    // If multi-contact, update perimeters
                    if (Array.isArray(sel)) ensureSharedPerimeters(sel);
                });
            });
            tdNs.appendChild(nsBtn);
            tr.appendChild(tdNs);

            const tdChunks = document.createElement('td');
            tdChunks.textContent = s.chunk_count;
            tr.appendChild(tdChunks);

            const tdSize = document.createElement('td');
            tdSize.textContent = formatSize(s.file_size);
            tr.appendChild(tdSize);

            const tdStatus = document.createElement('td');
            const statusBadge = document.createElement('span');
            statusBadge.className = 'badge badge-' + (s.status === 'ready' ? 'success' : 'warning');
            statusBadge.textContent = s.status;
            tdStatus.appendChild(statusBadge);
            tr.appendChild(tdStatus);

            const tdDate = document.createElement('td');
            tdDate.textContent = formatDate(s.created_at);
            tr.appendChild(tdDate);

            const tdAction = document.createElement('td');
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-sm btn-danger';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => deleteSource(s.id));
            tdAction.appendChild(delBtn);
            tr.appendChild(tdAction);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        container.appendChild(table);
    } catch (e) {
        container.textContent = '';
        showErrorState('sources-list', 'Could not load knowledge sources.', loadSources);
    }
}

async function updateSourceNamespace(id, namespace) {
    try {
        await fetch('/api/v1/knowledge/sources/namespace', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, namespace: namespace }),
        });
    } catch (e) {
        alert('Failed to update namespace: ' + e.message);
        loadSources();
    }
}

async function deleteSource(id) {
    if (!confirm('Remove this source and all its chunks?')) return;
    try {
        await fetch('/api/v1/knowledge/sources?id=' + id, { method: 'DELETE' });
        loadSources();
        loadStats();
    } catch (e) {
        alert('Failed to delete source: ' + e.message);
    }
}

// ─── Upload ───────────────────────────────────────────

function setupUpload() {
    const zone = document.getElementById('upload-zone');
    const input = document.getElementById('file-input');

    zone.addEventListener('dragover', e => {
        e.preventDefault();
        zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
    });
    input.addEventListener('change', () => {
        if (input.files.length > 0) uploadFiles(input.files);
    });
}

async function uploadFiles(files) {
    const progress = document.getElementById('upload-progress');
    showProgress('upload-progress', 'Uploading ' + files.length + ' file(s)\u2026');

    const formData = new FormData();
    for (const file of files) {
        formData.append('files', file);
    }

    try {
        const pf = getKnowledgeProfileFilter();
        const ns = getSelectedNamespace();
        var params = [];
        if (pf) params.push('profile=' + encodeURIComponent(pf));
        if (ns && ns !== '_private') params.push('namespace=' + encodeURIComponent(ns));
        var qs = params.length ? '?' + params.join('&') : '';
        const resp = await fetch('/api/v1/knowledge/ingest' + qs, {
            method: 'POST',
            body: formData,
        });
        const data = await resp.json();

        hideProgress('upload-progress');

        if (data.ingested && data.ingested.length > 0) {
            const heading = document.createElement('p');
            heading.className = 'upload-success';
            heading.textContent = 'Ingested:';
            progress.appendChild(heading);
            const ul = document.createElement('ul');
            data.ingested.forEach(item => {
                const li = document.createElement('li');
                const status = item.status === 'duplicate'
                    ? ' (duplicate, skipped)'
                    : ' (ID: ' + item.source_id + ')';
                li.textContent = item.file + status;
                ul.appendChild(li);
            });
            progress.appendChild(ul);
        }
        if (data.errors && data.errors.length > 0) {
            const heading = document.createElement('p');
            heading.className = 'upload-error';
            heading.textContent = 'Errors:';
            progress.appendChild(heading);
            const ul = document.createElement('ul');
            data.errors.forEach(err => {
                const li = document.createElement('li');
                li.textContent = err;
                ul.appendChild(li);
            });
            progress.appendChild(ul);
        }

        // Multi-contact: update perimeters so all selected contacts see the doc
        await ensureSharedPerimeters(getSelectedNamespaces());

        loadSources();
        loadStats();
    } catch (e) {
        hideProgress('upload-progress');
        progress.style.display = 'block';
        progress.textContent = 'Upload failed: ' + e.message;
    }
}

// ─── Search ───────────────────────────────────────────

function setupSearch() {
    const input = document.getElementById('knowledge-search');
    const btn = document.getElementById('search-btn');

    btn.addEventListener('click', () => doSearch(input.value));
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') doSearch(input.value);
    });
}

async function doSearch(query) {
    const container = document.getElementById('search-results');
    if (!query.trim()) {
        container.textContent = '';
        return;
    }

    showProgress('search-results', 'Searching\u2026');
    try {
        const pf = getKnowledgeProfileFilter();
        const profileParam = pf ? '&profile=' + encodeURIComponent(pf) : '';
        const resp = await fetch('/api/v1/knowledge/search?q=' + encodeURIComponent(query) + '&limit=5' + profileParam);
        const data = await resp.json();
        const results = data.results || [];
        hideProgress('search-results');

        if (results.length === 0) {
            const p = document.createElement('p');
            p.className = 'empty-state';
            p.textContent = 'No results found.';
            container.appendChild(p);
            return;
        }

        results.forEach(r => {
            const card = document.createElement('div');
            card.className = 'search-result-card';

            const header = document.createElement('div');
            header.className = 'search-result-header';
            const fileSpan = document.createElement('span');
            fileSpan.className = 'search-result-file';
            fileSpan.textContent = r.source_file;
            header.appendChild(fileSpan);

            if (r.sensitive) {
                const lockSpan = document.createElement('span');
                lockSpan.className = 'badge badge-warning';
                lockSpan.textContent = 'Sensitive';
                lockSpan.style.marginLeft = '8px';
                header.appendChild(lockSpan);
            }

            const scoreSpan = document.createElement('span');
            scoreSpan.className = 'search-result-score';
            scoreSpan.textContent = (r.score * 100).toFixed(0) + '%';
            header.appendChild(scoreSpan);
            card.appendChild(header);

            if (r.heading) {
                const headingDiv = document.createElement('div');
                headingDiv.className = 'search-result-heading';
                headingDiv.textContent = r.heading;
                card.appendChild(headingDiv);
            }

            const contentDiv = document.createElement('div');
            contentDiv.className = 'search-result-content';
            contentDiv.textContent = r.content.substring(0, 500);
            card.appendChild(contentDiv);

            if (r.sensitive) {
                const revealBtn = document.createElement('button');
                revealBtn.className = 'btn btn-sm';
                revealBtn.textContent = 'Reveal';
                revealBtn.style.marginTop = '8px';
                revealBtn.addEventListener('click', () => revealChunk(r.chunk_id, contentDiv, revealBtn));
                card.appendChild(revealBtn);
            }

            container.appendChild(card);
        });
    } catch (e) {
        hideProgress('search-results');
        container.textContent = 'Search failed: ' + e.message;
    }
}

// ─── Folder Indexing ─────────────────────────────────

function setupFolderIndex() {
    const btn = document.getElementById('index-folder-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const path = document.getElementById('folder-path').value.trim();
        if (!path) { alert('Enter a folder path'); return; }
        const recursive = document.getElementById('folder-recursive').checked;
        const ns = getSelectedNamespace();
        btn.disabled = true;
        showProgress('folder-progress', 'Indexing \u201c' + path + '\u201d\u2026');
        try {
            const resp = await fetch('/api/v1/knowledge/ingest-directory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path,
                    recursive,
                    profile: getKnowledgeProfileFilter(),
                    namespace: ns !== '_private' ? ns : undefined,
                }),
            });
            const data = await resp.json();
            hideProgress('folder-progress');
            const progress = document.getElementById('folder-progress');
            progress.style.display = 'block';
            if (data.error) {
                progress.textContent = 'Error: ' + data.error;
            } else {
                progress.textContent = 'Indexed ' + data.indexed + ' file(s).';
                loadSources();
                loadStats();
            }
        } catch (e) {
            hideProgress('folder-progress');
            const progress = document.getElementById('folder-progress');
            progress.style.display = 'block';
            progress.textContent = 'Failed: ' + e.message;
        } finally {
            btn.disabled = false;
        }
    });
}

// ─── Reveal Sensitive Chunk ──────────────────────

async function revealChunk(chunkId, contentDiv, btn) {
    let code = '';
    const body = { chunk_id: chunkId };

    try {
        let resp = await fetch('/api/v1/knowledge/reveal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        let data = await resp.json();

        if (data.requires_2fa) {
            code = prompt('Enter 2FA code to reveal sensitive content:');
            if (!code) return;
            body.code = code;
            resp = await fetch('/api/v1/knowledge/reveal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            data = await resp.json();
        }

        if (data.error) {
            alert(data.error);
            return;
        }

        contentDiv.textContent = data.content;
        btn.textContent = 'Revealed';
        btn.disabled = true;
    } catch (e) {
        alert('Failed to reveal: ' + e.message);
    }
}

// ─── Utilities ────────────────────────────────────────

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatDate(dateStr) {
    if (!dateStr) return '\u2014';
    try {
        const d = new Date(dateStr + 'Z');
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return dateStr;
    }
}
