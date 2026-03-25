// Knowledge Base page — upload, search, list sources
// KIX-2: contact-based namespace assignment with searchable contact picker

/** Cached contacts list for namespace selectors. */
var _cachedContacts = null;
/** Current selected namespace for upload. */
var _selectedNamespace = '_private';

document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('profile-changed', () => { loadStats(); loadSources(); loadWatches(); });
    loadStats();
    loadContacts().then(() => { loadSources(); loadWatches(); });
    setupUpload();
    setupSearch();
    setupWatches();
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

// ─── Monitored Folders (KWA-3) ──────────────────────────
// Note: innerHTML usage below is safe — all dynamic values are escaped
// via escapeHtml() and namespaceLabel() which sanitize user input.

function setupWatches() {
    var addBtn = document.getElementById('btn-add-watch');
    if (addBtn) addBtn.addEventListener('click', showAddWatchForm);
}

async function loadWatches() {
    var list = document.getElementById('watches-list');
    if (!list) return;
    try {
        var res = await api('/api/v1/knowledge/watches');
        if (!res.ok) throw new Error(res.body?.error || 'Failed to load');
        var watches = res.body.watches || [];
        renderWatches(watches, list);
    } catch (e) {
        list.textContent = '';
        var p = document.createElement('p');
        p.className = 'empty-state';
        p.textContent = 'Failed to load watches.';
        list.appendChild(p);
    }
}

function renderWatches(watches, container) {
    if (!watches.length) {
        container.textContent = '';
        var p = document.createElement('p');
        p.className = 'empty-state';
        p.textContent = 'No monitored folders configured.';
        container.appendChild(p);
        return;
    }
    // Build table using safe DOM construction for data cells
    var table = document.createElement('table');
    table.className = 'sources-table';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Path', 'Status', 'Namespace', 'Contacts', 'Docs', ''].forEach(function(h) {
        var th = document.createElement('th');
        th.textContent = h;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = 0; i < watches.length; i++) {
        var w = watches[i];
        var tr = document.createElement('tr');
        tr.dataset.watchId = w.id;

        // Path cell
        var tdPath = document.createElement('td');
        tdPath.title = w.path;
        tdPath.textContent = shortenPath(w.path);
        tr.appendChild(tdPath);

        // Status cell (safe: only our own badge markup)
        var tdStatus = document.createElement('td');
        var statusSpan = document.createElement('span');
        statusSpan.className = w.enabled ? 'badge badge-success' : 'badge badge-neutral';
        statusSpan.textContent = w.enabled ? 'Active' : 'Paused';
        tdStatus.appendChild(statusSpan);
        if (w.recursive) {
            var recSpan = document.createElement('span');
            recSpan.className = 'badge badge-neutral';
            recSpan.textContent = 'recursive';
            recSpan.style.marginLeft = '4px';
            tdStatus.appendChild(recSpan);
        }
        tr.appendChild(tdStatus);

        // Namespace cell
        var tdNs = document.createElement('td');
        tdNs.textContent = namespaceLabel(w.namespace);
        tr.appendChild(tdNs);

        // Contacts cell
        var tdContacts = document.createElement('td');
        var contactCount = (w.contact_ids || []).length;
        tdContacts.textContent = contactCount > 0 ? contactCount + ' contact' + (contactCount > 1 ? 's' : '') : '\u2014';
        tr.appendChild(tdContacts);

        // Docs cell
        var tdDocs = document.createElement('td');
        tdDocs.textContent = w.doc_count;
        tr.appendChild(tdDocs);

        // Actions cell
        var tdActions = document.createElement('td');
        tdActions.className = 'actions-cell';
        var toggle = document.createElement('label');
        toggle.className = 'toggle-switch toggle-sm';
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = w.enabled;
        checkbox.dataset.watchToggle = w.id;
        var slider = document.createElement('span');
        slider.className = 'toggle-slider';
        toggle.appendChild(checkbox);
        toggle.appendChild(slider);
        tdActions.appendChild(toggle);

        var delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-danger';
        delBtn.textContent = 'Delete';
        delBtn.dataset.watchDelete = w.id;
        delBtn.style.marginLeft = '8px';
        tdActions.appendChild(delBtn);
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.textContent = '';
    container.appendChild(table);

    // Bind toggle events
    container.querySelectorAll('[data-watch-toggle]').forEach(function(input) {
        input.addEventListener('change', function() {
            toggleWatchEnabled(parseInt(input.dataset.watchToggle), input.checked);
        });
    });

    // Bind delete events
    container.querySelectorAll('[data-watch-delete]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            deleteWatch(parseInt(btn.dataset.watchDelete));
        });
    });
}

function showAddWatchForm() {
    if (document.getElementById('watch-add-form')) return;
    var list = document.getElementById('watches-list');
    if (!list) return;

    var form = document.createElement('div');
    form.id = 'watch-add-form';
    form.className = 'inline-form';
    form.style.cssText = 'margin-bottom:1rem;padding:1rem;border:1px solid var(--border);border-radius:var(--radius)';

    // Path input
    var pathGroup = document.createElement('div');
    pathGroup.className = 'form-group';
    var pathLabel = document.createElement('label');
    pathLabel.textContent = 'Path';
    var pathInput = document.createElement('input');
    pathInput.id = 'watch-path';
    pathInput.className = 'input';
    pathInput.type = 'text';
    pathInput.placeholder = '~/Documents/knowledge';
    pathGroup.appendChild(pathLabel);
    pathGroup.appendChild(pathInput);
    form.appendChild(pathGroup);

    // Options row
    var optRow = document.createElement('div');
    optRow.style.cssText = 'display:flex;gap:1rem;flex-wrap:wrap';

    // Recursive checkbox
    var recGroup = document.createElement('div');
    recGroup.className = 'form-group';
    var recLabel = document.createElement('label');
    var recCheck = document.createElement('input');
    recCheck.id = 'watch-recursive';
    recCheck.type = 'checkbox';
    recCheck.checked = true;
    recLabel.appendChild(recCheck);
    recLabel.appendChild(document.createTextNode(' Recursive'));
    recGroup.appendChild(recLabel);
    optRow.appendChild(recGroup);

    // Namespace select
    var nsGroup = document.createElement('div');
    nsGroup.className = 'form-group';
    var nsLabel = document.createElement('label');
    nsLabel.textContent = 'Namespace';
    var nsSel = document.createElement('select');
    nsSel.id = 'watch-namespace';
    nsSel.className = 'input';
    nsSel.style.minWidth = '140px';
    var optPrivate = document.createElement('option');
    optPrivate.value = '_private'; optPrivate.textContent = 'Private';
    var optPublic = document.createElement('option');
    optPublic.value = '_public'; optPublic.textContent = 'Public';
    nsSel.appendChild(optPrivate);
    nsSel.appendChild(optPublic);
    if (_cachedContacts) {
        _cachedContacts.forEach(function(c) {
            var opt = document.createElement('option');
            opt.value = 'contact_' + c.id;
            opt.textContent = c.display_name || c.name;
            nsSel.appendChild(opt);
        });
    }
    nsGroup.appendChild(nsLabel);
    nsGroup.appendChild(nsSel);
    optRow.appendChild(nsGroup);
    form.appendChild(optRow);

    // Buttons
    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:0.5rem;margin-top:0.5rem';
    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', saveNewWatch);
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function() { form.remove(); });
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    form.appendChild(btnRow);

    list.parentNode.insertBefore(form, list);
}

async function saveNewWatch() {
    var path = document.getElementById('watch-path')?.value?.trim();
    if (!path) { alert('Path is required'); return; }

    var data = {
        path: path,
        recursive: document.getElementById('watch-recursive')?.checked ?? true,
        namespace: document.getElementById('watch-namespace')?.value || '_private',
        contact_ids: '[]',
    };

    var res = await api('/api/v1/knowledge/watches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (res.ok) {
        var form = document.getElementById('watch-add-form');
        if (form) form.remove();
        loadWatches();
        showToast('Folder added', 'success');
    } else {
        alert(res.body?.error || 'Failed to create watch');
    }
}

async function toggleWatchEnabled(id, enabled) {
    var res = await api('/api/v1/knowledge/watches');
    if (!res.ok) return;
    var watch = (res.body.watches || []).find(function(w) { return w.id === id; });
    if (!watch) return;

    await api('/api/v1/knowledge/watches/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            path: watch.path,
            recursive: watch.recursive,
            enabled: enabled,
            namespace: watch.namespace,
            contact_ids: JSON.stringify(watch.contact_ids || []),
        }),
    });
    loadWatches();
}

async function deleteWatch(id) {
    if (!confirm('Remove this monitored folder?')) return;
    var res = await api('/api/v1/knowledge/watches/' + id, { method: 'DELETE' });
    if (res.ok) {
        loadWatches();
        showToast('Folder removed', 'success');
    } else {
        alert(res.body?.error || 'Failed to delete');
    }
}

function shortenPath(p) {
    if (!p) return '';
    if (p.startsWith('/Users/')) {
        var parts = p.split('/');
        if (parts.length > 2) return '~/' + parts.slice(3).join('/');
    }
    return p;
}
