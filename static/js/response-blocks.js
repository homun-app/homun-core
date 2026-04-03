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

        const dlBtn = document.createElement('a');
        dlBtn.href = downloadUrl;
        dlBtn.setAttribute('download', '');
        dlBtn.className = 'rb-action-btn';
        dlBtn.textContent = '⬇ Download';
        dlBtn.style.cssText = 'padding:6px 14px;border-radius:6px;background:var(--accent,#3b82f6);color:#fff;text-decoration:none;font-size:13px;font-weight:500';
        actions.appendChild(dlBtn);

        const viewBtn = document.createElement('a');
        viewBtn.href = downloadUrl;
        viewBtn.target = '_blank';
        viewBtn.className = 'rb-action-btn';
        viewBtn.textContent = '👁 View';
        viewBtn.style.cssText = 'padding:6px 14px;border-radius:6px;background:var(--surface-2,#e5e7eb);color:var(--text-1,#111);text-decoration:none;font-size:13px;font-weight:500';
        actions.appendChild(viewBtn);

        card.appendChild(actions);
    }

    return card;
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
