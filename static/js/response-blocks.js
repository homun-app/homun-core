// Homun — Rich Response Blocks renderer
//
// Renders structured blocks (choice cards, approvals, status, etc.) inside
// chat messages. Capable clients show native UI; fallback is the markdown text.
//
// Usage:
//   renderBlocks(blocks, containerEl, sendFn)
//   sendFn(replyText, blockResponse) — sends WS message with content + block_response

/* exported renderBlocks */

// ─── Main Renderer ──────────────────────────────────────────────

/**
 * Render an array of ResponseBlock objects into a container element.
 * @param {Array} blocks - Array of block objects with block_type field
 * @param {HTMLElement} container - DOM element to append blocks to
 * @param {Function} sendFn - (replyText, blockResponse) => void
 */
function renderBlocks(blocks, container, sendFn) {
    if (!blocks || !blocks.length) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'response-blocks';

    for (const block of blocks) {
        const el = renderBlock(block, sendFn);
        if (el) wrapper.appendChild(el);
    }

    container.appendChild(wrapper);
}

function renderBlock(block, sendFn) {
    switch (block.block_type) {
        case 'choice':    return renderChoiceBlock(block, sendFn);
        case 'approval':  return renderApprovalBlock(block, sendFn);
        case 'status':    return renderStatusBlock(block);
        case 'result':    return renderResultBlock(block);
        case 'external_message': return renderExternalMessageBlock(block, sendFn);
        default:          return renderUnsupportedBlock(block);
    }
}

// ─── Choice Block ───────────────────────────────────────────────

function renderChoiceBlock(block, sendFn) {
    const card = createBlockCard('choice');

    const header = document.createElement('div');
    header.className = 'rb-header';
    header.textContent = block.title || 'Choose an option';
    card.appendChild(header);

    if (block.subtitle) {
        const sub = document.createElement('div');
        sub.className = 'rb-subtitle';
        sub.textContent = block.subtitle;
        card.appendChild(sub);
    }

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'rb-options';

    for (const opt of (block.options || [])) {
        const btn = document.createElement('button');
        btn.className = 'rb-option';
        btn.type = 'button';

        const labelEl = document.createElement('span');
        labelEl.className = 'rb-option-label';
        labelEl.textContent = opt.label || opt.id;
        btn.appendChild(labelEl);

        if (opt.subtitle) {
            const subtitleEl = document.createElement('span');
            subtitleEl.className = 'rb-option-subtitle';
            subtitleEl.textContent = opt.subtitle;
            btn.appendChild(subtitleEl);
        }

        btn.addEventListener('click', () => {
            // Compose human-readable reply text from label + subtitle
            const replyText = opt.subtitle
                ? `${opt.label} — ${opt.subtitle}`
                : opt.label;

            const blockResponse = {
                block_id: block.id,
                option_id: opt.id,
                metadata: opt.metadata || null,
            };

            // Disable all options after selection
            optionsContainer.querySelectorAll('.rb-option').forEach(b => {
                b.disabled = true;
                b.classList.remove('rb-option--selected');
            });
            btn.classList.add('rb-option--selected');

            sendFn(replyText, blockResponse);
        });

        optionsContainer.appendChild(btn);
    }

    card.appendChild(optionsContainer);
    return card;
}

// ─── Approval Block ─────────────────────────────────────────────

function renderApprovalBlock(block, sendFn) {
    const card = createBlockCard('approval');

    const header = document.createElement('div');
    header.className = 'rb-header';
    header.textContent = block.title || 'Approval required';
    card.appendChild(header);

    if (block.description) {
        const desc = document.createElement('div');
        desc.className = 'rb-description';
        desc.textContent = block.description;
        card.appendChild(desc);
    }

    const actions = document.createElement('div');
    actions.className = 'rb-actions';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'rb-btn rb-btn--approve';
    approveBtn.type = 'button';
    approveBtn.textContent = block.approve_label || 'Approve';

    const denyBtn = document.createElement('button');
    denyBtn.className = 'rb-btn rb-btn--deny';
    denyBtn.type = 'button';
    denyBtn.textContent = block.deny_label || 'Deny';

    function handleAction(action, label) {
        approveBtn.disabled = true;
        denyBtn.disabled = true;
        sendFn(label, {
            block_id: block.id,
            action: action,
            metadata: block.metadata || null,
        });
    }

    approveBtn.addEventListener('click', () => handleAction('approve', block.approve_label || 'Approve'));
    denyBtn.addEventListener('click', () => handleAction('deny', block.deny_label || 'Deny'));

    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    card.appendChild(actions);
    return card;
}

// ─── Status Block ───────────────────────────────────────────────

function renderStatusBlock(block) {
    const card = createBlockCard('status');

    const header = document.createElement('div');
    header.className = 'rb-header';

    const statusBadge = document.createElement('span');
    statusBadge.className = `rb-status-badge rb-status--${block.status || 'pending'}`;
    statusBadge.textContent = block.status || 'pending';

    header.textContent = block.title || 'Status';
    header.appendChild(statusBadge);
    card.appendChild(header);

    if (block.fields && block.fields.length) {
        card.appendChild(renderFields(block.fields));
    }

    return card;
}

// ─── Result Block ───────────────────────────────────────────────

function renderResultBlock(block) {
    const card = createBlockCard('result');

    // Icon + title
    const header = document.createElement('div');
    header.className = 'rb-header';
    const iconText = block.icon ? block.icon + ' ' : '';
    header.textContent = iconText + (block.title || 'Result');
    card.appendChild(header);

    // Separate download URL from display fields
    const displayFields = [];
    let downloadUrl = null;
    if (block.fields) {
        for (const f of block.fields) {
            if (f.label === 'Download' && f.value.startsWith('/api/')) {
                downloadUrl = f.value;
            } else {
                displayFields.push(f);
            }
        }
    }

    if (displayFields.length) {
        card.appendChild(renderFields(displayFields));
    }

    // File action buttons (download + view)
    if (downloadUrl) {
        const actions = document.createElement('div');
        actions.className = 'rb-actions';
        actions.style.cssText = 'display:flex;gap:8px;margin-top:8px';

        const viewBtn = document.createElement('button');
        viewBtn.className = 'rb-action-btn rb-action-btn--primary';
        viewBtn.textContent = '👁 View';
        viewBtn.addEventListener('click', () => openFileViewer(downloadUrl, block.title || 'File'));
        actions.appendChild(viewBtn);

        const dlBtn = document.createElement('a');
        dlBtn.href = downloadUrl;
        dlBtn.setAttribute('download', '');
        dlBtn.className = 'rb-action-btn rb-action-btn--secondary';
        dlBtn.textContent = '⬇ Download';
        actions.appendChild(dlBtn);

        card.appendChild(actions);
    }

    return card;
}

// ─── File Viewer Modal ─────────────────────────────────────────

/** Open a modal to preview a workspace file with smart rendering by type. */
async function openFileViewer(url, filename) {
    // Remove existing viewer if any
    const existing = document.getElementById('file-viewer-modal');
    if (existing) existing.remove();

    const ext = (filename.split('.').pop() || '').toLowerCase();

    // Build modal structure
    const overlay = document.createElement('div');
    overlay.id = 'file-viewer-modal';
    overlay.className = 'fv-overlay';

    const modal = document.createElement('div');
    modal.className = 'fv-modal';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'fv-header';
    const title = document.createElement('span');
    title.className = 'fv-title';
    title.textContent = filename;
    hdr.appendChild(title);

    const headerActions = document.createElement('div');
    headerActions.className = 'fv-header-actions';

    const fsBtn = document.createElement('button');
    fsBtn.className = 'fv-btn-icon';
    fsBtn.title = 'Toggle fullscreen';
    fsBtn.textContent = '\u26F6'; // ⛶
    fsBtn.addEventListener('click', () => modal.classList.toggle('fv-fullscreen'));
    headerActions.appendChild(fsBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'fv-btn-icon';
    closeBtn.textContent = '\u2715'; // ✕
    closeBtn.addEventListener('click', () => overlay.remove());
    headerActions.appendChild(closeBtn);

    hdr.appendChild(headerActions);
    modal.appendChild(hdr);

    // Body (content rendered based on file type)
    const body = document.createElement('div');
    body.className = 'fv-body';
    body.textContent = 'Loading\u2026';
    modal.appendChild(body);

    // Footer with download
    const footer = document.createElement('div');
    footer.className = 'fv-footer';
    const dlLink = document.createElement('a');
    dlLink.href = url;
    dlLink.setAttribute('download', '');
    dlLink.className = 'rb-action-btn rb-action-btn--primary';
    dlLink.textContent = '\u2B07 Download';
    footer.appendChild(dlLink);
    modal.appendChild(footer);

    overlay.appendChild(modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const escHandler = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(overlay);

    // Fetch and render content
    try {
        const inlineUrl = url + (url.includes('?') ? '&' : '?') + 'inline=true';

        if (ext === 'pdf') {
            const embed = document.createElement('embed');
            embed.src = inlineUrl;
            embed.type = 'application/pdf';
            embed.style.cssText = 'width:100%;height:100%;border:none';
            body.textContent = '';
            body.appendChild(embed);

        } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
            const img = document.createElement('img');
            img.src = inlineUrl;
            img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;margin:auto;display:block';
            body.textContent = '';
            body.appendChild(img);

        } else {
            const resp = await fetch(inlineUrl);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const text = await resp.text();
            body.textContent = '';

            if (ext === 'csv') {
                body.appendChild(renderCsvTable(text));
            } else if (ext === 'json') {
                renderCodeBlock(body, text, 'json');
            } else if (ext === 'md') {
                renderMarkdownContent(body, text);
            } else {
                const pre = document.createElement('pre');
                pre.className = 'fv-pre';
                pre.textContent = text;
                body.appendChild(pre);
            }
        }
    } catch (err) {
        body.textContent = '';
        const errMsg = document.createElement('div');
        errMsg.className = 'fv-error';
        errMsg.textContent = 'Preview not available: ' + err.message;
        body.appendChild(errMsg);
    }
}

/** Parse CSV text and render as an HTML table. */
function renderCsvTable(text) {
    const lines = text.trim().split('\n');
    if (!lines.length) return document.createTextNode('Empty file');

    const table = document.createElement('table');
    table.className = 'fv-table';

    function parseLine(line) {
        const fields = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
                else { inQuotes = !inQuotes; }
            } else if (ch === ',' && !inQuotes) {
                fields.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        fields.push(current.trim());
        return fields;
    }

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const col of parseLine(lines[0])) {
        const th = document.createElement('th');
        th.textContent = col;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const row = document.createElement('tr');
        for (const cell of parseLine(lines[i])) {
            const td = document.createElement('td');
            td.textContent = cell;
            row.appendChild(td);
        }
        tbody.appendChild(row);
    }
    table.appendChild(tbody);

    const wrapper = document.createElement('div');
    wrapper.className = 'fv-table-wrap';
    wrapper.appendChild(table);
    return wrapper;
}

/** Render code with syntax highlighting. */
function renderCodeBlock(container, text, language) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = language ? 'language-' + language : '';
    code.textContent = text;
    pre.appendChild(code);
    container.appendChild(pre);
    if (typeof hljs !== 'undefined') hljs.highlightElement(code);
}

/** Render markdown content safely using marked + DOMPurify. */
function renderMarkdownContent(container, text) {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        const raw = marked.parse(text);
        // safe: DOMPurify sanitizes all HTML
        container.appendChild(DOMPurify.sanitize(raw, { RETURN_DOM_FRAGMENT: true, ADD_ATTR: ['target'] }));
    } else {
        const pre = document.createElement('pre');
        pre.textContent = text;
        container.appendChild(pre);
    }
}

// ─── External Message Block ─────────────────────────────────────

function renderExternalMessageBlock(block, sendFn) {
    const card = createBlockCard('external-message');

    const meta = document.createElement('div');
    meta.className = 'rb-external-meta';
    if (block.sender) {
        const sender = document.createElement('span');
        sender.className = 'rb-external-sender';
        sender.textContent = block.sender;
        meta.appendChild(sender);
    }
    const source = document.createElement('span');
    source.className = 'rb-external-source';
    source.textContent = block.source || '';
    meta.appendChild(source);
    card.appendChild(meta);

    if (block.subject) {
        const subject = document.createElement('div');
        subject.className = 'rb-header';
        subject.textContent = block.subject;
        card.appendChild(subject);
    }

    const preview = document.createElement('div');
    preview.className = 'rb-description';
    preview.textContent = block.preview || '';
    card.appendChild(preview);

    return card;
}

// ─── Helpers ────────────────────────────────────────────────────

function createBlockCard(typeClass) {
    const card = document.createElement('div');
    card.className = `rb-card rb-card--${typeClass}`;
    return card;
}

function renderFields(fields) {
    const table = document.createElement('div');
    table.className = 'rb-fields';
    for (const f of fields) {
        const row = document.createElement('div');
        row.className = 'rb-field';
        const label = document.createElement('span');
        label.className = 'rb-field-label';
        label.textContent = f.label;
        const value = document.createElement('span');
        value.className = 'rb-field-value';
        value.textContent = f.value;
        row.appendChild(label);
        row.appendChild(value);
        table.appendChild(row);
    }
    return table;
}

function renderUnsupportedBlock(block) {
    const card = createBlockCard('unsupported');
    const header = document.createElement('div');
    header.className = 'rb-header';
    header.textContent = block.title || `Block: ${block.block_type}`;
    card.appendChild(header);
    return card;
}
