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

/** Get the selected namespace for upload. */
function getSelectedNamespace() {
    return _selectedNamespace;
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
        openVisibilityPicker(btn, function (ns) {
            _selectedNamespace = ns;
            btn.textContent = namespaceLabel(ns);
        });
    });
}

/** Open a searchable picker popover anchored to the trigger button. */
function openVisibilityPicker(anchor, onSelect) {
    // Close any existing picker
    closeVisibilityPicker();

    var popover = document.createElement('div');
    popover.className = 'knowledge-vis-picker';
    popover.id = 'knowledge-vis-picker';

    // Search input
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'input knowledge-vis-search';
    searchInput.placeholder = 'Search contacts\u2026';
    searchInput.autocomplete = 'off';
    popover.appendChild(searchInput);

    // Options list
    var list = document.createElement('div');
    list.className = 'knowledge-vis-list';
    popover.appendChild(list);

    function renderOptions(filter) {
        list.textContent = '';
        var q = (filter || '').toLowerCase();

        // Fixed options
        var fixed = [
            { ns: '_private', label: 'Only me', desc: 'Only you can see these documents' },
            { ns: '_public', label: 'All contacts', desc: 'Visible to every contact' },
        ];
        fixed.forEach(function (opt) {
            if (q && opt.label.toLowerCase().indexOf(q) === -1) return;
            list.appendChild(makePickerItem(opt.ns, opt.label, opt.desc, onSelect));
        });

        // Contact options
        if (_cachedContacts && _cachedContacts.length > 0) {
            var filtered = _cachedContacts.filter(function (c) {
                return !q || c.name.toLowerCase().indexOf(q) !== -1;
            });
            if (filtered.length > 0) {
                var divider = document.createElement('div');
                divider.className = 'knowledge-vis-divider';
                divider.textContent = 'Contacts';
                list.appendChild(divider);
            }
            filtered.forEach(function (c) {
                var ns = 'contact_' + c.id;
                list.appendChild(makePickerItem(ns, c.name, null, onSelect));
            });

            if (filtered.length === 0 && q) {
                var empty = document.createElement('div');
                empty.className = 'knowledge-vis-empty';
                empty.textContent = 'No contacts matching \u201c' + filter + '\u201d';
                list.appendChild(empty);
            }
        }
    }

    searchInput.addEventListener('input', function () {
        renderOptions(this.value);
    });

    renderOptions('');

    // Position below anchor
    var rect = anchor.getBoundingClientRect();
    popover.style.top = (rect.bottom + 4) + 'px';
    popover.style.left = rect.left + 'px';
    popover.style.minWidth = Math.max(rect.width, 260) + 'px';

    document.body.appendChild(popover);

    // Focus search
    searchInput.focus();

    // Close on outside click
    setTimeout(function () {
        document.addEventListener('click', onPickerOutsideClick);
        document.addEventListener('keydown', onPickerEscape);
    }, 0);
}

function makePickerItem(ns, label, desc, onSelect) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'knowledge-vis-item' + (_selectedNamespace === ns ? ' is-active' : '');

    var nameEl = document.createElement('span');
    nameEl.className = 'knowledge-vis-item-name';
    nameEl.textContent = label;
    item.appendChild(nameEl);

    if (desc) {
        var descEl = document.createElement('span');
        descEl.className = 'knowledge-vis-item-desc';
        descEl.textContent = desc;
        item.appendChild(descEl);
    }

    item.addEventListener('click', function () {
        onSelect(ns);
        closeVisibilityPicker();
    });
    return item;
}

function closeVisibilityPicker() {
    var el = document.getElementById('knowledge-vis-picker');
    if (el) el.remove();
    document.removeEventListener('click', onPickerOutsideClick);
    document.removeEventListener('keydown', onPickerEscape);
}

function onPickerOutsideClick(e) {
    var picker = document.getElementById('knowledge-vis-picker');
    if (picker && !picker.contains(e.target)) {
        var btn = document.getElementById('upload-namespace-btn');
        if (btn && btn.contains(e.target)) return;
        closeVisibilityPicker();
    }
}

function onPickerEscape(e) {
    if (e.key === 'Escape') closeVisibilityPicker();
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
                openVisibilityPicker(nsBtn, function (ns) {
                    updateSourceNamespace(s.id, ns);
                    nsBtn.textContent = namespaceLabel(ns);
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
