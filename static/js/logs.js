const LOG_LEVEL_PRIORITY = {
    trace: 0,
    debug: 1,
    info: 2,
    warn: 3,
    error: 4,
};

const MAX_LOG_EVENTS = 1500;

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeLevel(level) {
    const key = String(level || '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LOG_LEVEL_PRIORITY, key)) return key;
    return 'info';
}

function formatTimestamp(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const datePart = sameDay
        ? ''
        : `${date.toLocaleDateString()} `;
    const timePart = date.toLocaleTimeString([], { hour12: false });
    const millis = String(date.getMilliseconds()).padStart(3, '0');
    return `${datePart}${timePart}.${millis}`;
}

function levelPassesFilter(level, filterLevel) {
    const levelValue = LOG_LEVEL_PRIORITY[normalizeLevel(level)];
    const filterValue = LOG_LEVEL_PRIORITY[normalizeLevel(filterLevel)];
    return levelValue >= filterValue;
}

function statusBadgeClass(status) {
    if (status === 'live') return 'badge-success';
    if (status === 'retry') return 'badge-warning';
    if (status === 'error') return 'badge-error';
    return 'badge-neutral';
}

// Shared state across re-inits (SSE must persist across calls)
let _logsSource = null;
let _logsInitialized = false;

function initLogsPage() {
    const viewerEl = document.getElementById('log-viewer');
    const levelEl = document.getElementById('logs-level');
    const autoScrollEl = document.getElementById('logs-autoscroll');
    const clearEl = document.getElementById('logs-clear');
    const countEl = document.getElementById('logs-count');
    const statusEl = document.getElementById('logs-status');

    if (!viewerEl || !levelEl || !autoScrollEl || !clearEl || !countEl) return;

    // Close previous SSE if re-initializing (e.g. settings modal re-open)
    if (_logsSource) { _logsSource.close(); _logsSource = null; }

    // Profile filter managed by global topbar — re-render on change
    document.addEventListener('profile-changed', () => queueRender());

    const events = [];
    let source = null;
    let renderQueued = false;

    function setStatus(mode, label) {
        if (!statusEl) return;
        statusEl.className = `badge ${statusBadgeClass(mode)}`;
        statusEl.textContent = label;
    }

    function updateCount(visibleCount) {
        countEl.textContent = `${visibleCount} events`;
    }

    function render() {
        renderQueued = false;
        const filterLevel = normalizeLevel(levelEl.value);
        // Profile filter: empty string or falsy = show all; profile_id=null logs always pass
        const rawProfile = window.getActiveProfileId ? window.getActiveProfileId() : '';
        const filterProfile = rawProfile || '';
        const visible = events.filter((event) => {
            if (!levelPassesFilter(event.level, filterLevel)) return false;
            if (filterProfile && event.profile_id && event.profile_id != filterProfile) return false;
            return true;
        });

        if (visible.length === 0) {
            viewerEl.innerHTML = '<div class="empty-state log-empty"><p>No logs for this filter yet.</p></div>';
            updateCount(0);
            return;
        }

        viewerEl.innerHTML = visible
            .map((event) => {
                const level = normalizeLevel(event.level);
                const message = renderMessageCell(event);
                return `
                    <div class="log-line log-level-${level}">
                        <span class="log-cell-time">${escapeHtml(formatTimestamp(event.timestamp))}</span>
                        <span class="log-cell-level">${escapeHtml(level)}</span>
                        <span class="log-cell-target">${escapeHtml(event.target || '-')}</span>
                        <span class="log-cell-message">${message}</span>
                    </div>
                `;
            })
            .join('');

        updateCount(visible.length);

        if (autoScrollEl.checked) {
            viewerEl.scrollTop = viewerEl.scrollHeight;
        }
    }

    function queueRender() {
        if (renderQueued) return;
        renderQueued = true;
        window.requestAnimationFrame(render);
    }

    function pushEvent(rawEvent) {
        const event = {
            timestamp: rawEvent.timestamp,
            level: normalizeLevel(rawEvent.level),
            target: String(rawEvent.target || ''),
            message: String(rawEvent.message || ''),
            module_path: rawEvent.module_path ? String(rawEvent.module_path) : '',
            file: rawEvent.file ? String(rawEvent.file) : '',
            line: Number.isFinite(Number(rawEvent.line)) ? Number(rawEvent.line) : null,
            fields: Array.isArray(rawEvent.fields)
                ? rawEvent.fields
                    .filter((field) => field && field.key)
                    .map((field) => ({
                        key: String(field.key),
                        value: String(field.value ?? '')
                    }))
                : [],
            profile_id: rawEvent.profile_id ?? null,
            user_id: rawEvent.user_id ?? null,
        };

        const last = events[events.length - 1];
        if (last && eventFingerprint(last) === eventFingerprint(event)) {
            return;
        }

        events.push(event);

        if (events.length > MAX_LOG_EVENTS) {
            events.splice(0, events.length - MAX_LOG_EVENTS);
        }

        queueRender();
    }

    async function loadRecent() {
        try {
            const resp = await fetch('/api/v1/logs/recent?limit=250');
            if (!resp.ok) throw new Error('Failed to load recent logs');
            const recent = await resp.json();
            if (Array.isArray(recent)) {
                recent.forEach(pushEvent);
            }
        } catch (err) {
            console.error('[logs] loadRecent error:', err);
        }
    }

    function connect() {
        if (source) source.close();

        setStatus('retry', 'Connecting...');
        source = new EventSource('/api/v1/logs/stream');
        _logsSource = source; // track for cleanup on re-init

        source.onopen = () => {
            setStatus('live', 'Live');
        };

        source.onerror = () => {
            setStatus('retry', 'Reconnecting...');
        };

        source.addEventListener('log', (event) => {
            try {
                const payload = JSON.parse(event.data);
                pushEvent(payload);
            } catch (_error) {
                // Ignore malformed events to keep stream alive.
            }
        });
    }

    levelEl.addEventListener('change', queueRender);
    clearEl.addEventListener('click', () => {
        events.length = 0;
        queueRender();
    });

    window.addEventListener('beforeunload', () => {
        if (source) source.close();
    });

    // Close SSE when leaving settings section
    document.addEventListener('settings-section-unload', () => {
        if (source) { source.close(); source = null; }
    });

    loadRecent().finally(() => {
        connect();
        queueRender();
    });
}

function eventFingerprint(event) {
    return [
        event.timestamp || '',
        event.level || '',
        event.target || '',
        event.message || '',
        event.module_path || '',
        event.file || '',
        event.line || ''
    ].join('|');
}

function renderMessageCell(event) {
    const main = `<div class="log-message-main">${escapeHtml(event.message || '-')}</div>`;
    const sourceParts = [];
    if (event.file) {
        sourceParts.push(escapeHtml(event.line ? `${event.file}:${event.line}` : event.file));
    }
    if (event.module_path) {
        sourceParts.push(escapeHtml(event.module_path));
    }
    const source = sourceParts.length
        ? `<div class="log-message-source">${sourceParts.join(' · ')}</div>`
        : '';
    const fields = Array.isArray(event.fields) && event.fields.length
        ? `<div class="log-message-fields">${event.fields.map((field) => (
            `<span class="log-field-chip">${escapeHtml(field.key)}=${escapeHtml(field.value)}</span>`
        )).join('')}</div>`
        : '';
    return `${main}${source}${fields}`;
}

// Support both standalone page and settings modal
// On standalone pages, DOM is ready at script load; in modal, settings-section-loaded fires after.
// Both paths call initLogsPage — the second call closes the first SSE and restarts cleanly.
initLogsPage();
document.addEventListener('settings-section-loaded', initLogsPage);
