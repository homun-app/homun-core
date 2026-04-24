// Homun — chat conversation URL and formatting helpers.

function conversationApi(path, conversationId) {
    const url = new URL(path, window.location.origin);
    if (conversationId) {
        url.searchParams.set('conversation_id', conversationId);
    }
    return url.pathname + url.search;
}

function conversationResourceUrl(conversationId) {
    return `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}`;
}

function setConversationUrl(conversationId) {
    const url = new URL(window.location.href);
    url.searchParams.set('c', conversationId);
    window.history.replaceState({}, '', url);
}

function truncateConversationText(value, max = 48) {
    const compact = String(value || '').trim().replace(/\s+/g, ' ');
    if (!compact) return '';
    return compact.length > max ? `${compact.slice(0, max).trimEnd()}…` : compact;
}

function capitalizeFirst(text) {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatConversationTimestamp(value) {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const itemDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    if (itemDay >= today) {
        return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (itemDay >= yesterday) {
        return 'Ieri';
    }
    return parsed.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function groupConversationsByDate(convos) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const groups = [];
    let todayItems = [], yesterdayItems = [], olderItems = [];
    for (const conversation of convos) {
        const d = new Date(conversation.updated_at);
        const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        if (itemDay >= today) todayItems.push(conversation);
        else if (itemDay >= yesterday) yesterdayItems.push(conversation);
        else olderItems.push(conversation);
    }
    if (todayItems.length) groups.push({ label: 'Oggi', items: todayItems });
    if (yesterdayItems.length) groups.push({ label: 'Ieri', items: yesterdayItems });
    if (olderItems.length) groups.push({ label: 'Meno recenti', items: olderItems });
    return groups;
}

function parseSvg(str) {
    var t = document.createElement('template');
    t.innerHTML = str.trim();
    return t.content.firstChild;
}

function buildConversationItem(conversation, options) {
    const state = options.state;
    const actions = options.actions;
    var icMore = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="4" r="1.2"/><circle cx="9" cy="9" r="1.2"/><circle cx="9" cy="14" r="1.2"/></svg>';

    const item = document.createElement('div');
    item.className = 'chat-conversation-item';
    if (conversation.conversation_id === state.currentConversationId) item.classList.add('is-active');
    if (conversation.active_run && (conversation.active_run.status === 'running' || conversation.active_run.status === 'stopping')) {
        item.classList.add('is-running');
    }
    if (state.multiSelectMode) {
        item.classList.add('is-selectable');
        if (state.selectedConversations.has(conversation.conversation_id)) item.classList.add('is-selected');
    }
    if (state.openConversationMenuId === conversation.conversation_id) item.classList.add('has-menu-open');

    const checkWrap = document.createElement('div');
    checkWrap.className = 'chat-conv-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.multiSelectMode && state.selectedConversations.has(conversation.conversation_id);
    cb.addEventListener('click', function (e) {
        e.stopPropagation();
        actions.toggleConversationSelection(conversation.conversation_id);
    });
    checkWrap.appendChild(cb);
    item.appendChild(checkWrap);

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-conversation-name';
    nameEl.textContent = capitalizeFirst(conversation.title) || 'New conversation';
    nameEl.addEventListener('click', function () {
        if (state.multiSelectMode) {
            actions.toggleConversationSelection(conversation.conversation_id);
            return;
        }
        if (conversation.conversation_id !== state.currentConversationId) {
            actions.selectConversation(conversation.conversation_id);
        }
    });
    item.appendChild(nameEl);

    const trailing = document.createElement('div');
    trailing.className = 'chat-conv-trailing';

    const dateEl = document.createElement('span');
    dateEl.className = 'chat-conversation-date';
    dateEl.textContent = formatConversationTimestamp(conversation.updated_at);
    trailing.appendChild(dateEl);
    item.appendChild(trailing);

    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'chat-conv-more-btn';
    if (state.openConversationMenuId === conversation.conversation_id) moreBtn.classList.add('is-open');
    moreBtn.title = 'Actions';
    moreBtn.appendChild(parseSvg(icMore));
    moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.openConversationMenuId === conversation.conversation_id) {
            actions.closeConversationMenu();
        } else {
            actions.openConversationDropdown(conversation, moreBtn);
        }
    });
    item.appendChild(moreBtn);

    return item;
}

function renderConversationList(listEl, conversations, options) {
    if (!listEl) return;
    if (conversations.length === 0) {
        listEl.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'chat-conversation-empty';
        empty.textContent = 'No conversations yet.';
        listEl.appendChild(empty);
        return;
    }

    listEl.textContent = '';
    const groups = groupConversationsByDate(conversations);
    groups.forEach((group) => {
        const header = document.createElement('div');
        header.className = 'chat-date-group';
        header.textContent = group.label;
        listEl.appendChild(header);

        group.items.forEach((conversation) => {
            listEl.appendChild(buildConversationItem(conversation, options));
        });
    });
}

function buildConversationDropdown(conversation, actions) {
    var icRename = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 5.2l-1.8-1.8a2.5 2.5 0 00-3.5 0L3.5 9.9V14.5h4.6l6.4-6.4a2.5 2.5 0 000-3.5z"/></svg>';
    var icArchive = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="14" height="3" rx="1"/><path d="M3 6v8a1 1 0 001 1h10a1 1 0 001-1V6"/><path d="M7 10h4"/></svg>';
    var icDelete = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h12"/><path d="M7 5V3h4v2"/><path d="M5 5v10a1 1 0 001 1h6a1 1 0 001-1V5"/></svg>';
    var icSelect = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="12" height="12" rx="2"/><path d="M6 9l2 2 4-4"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'chat-conv-dropdown';

    function addItem(icon, label, cls, handler) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-conv-dropdown-item' + (cls ? ' ' + cls : '');
        btn.appendChild(parseSvg(icon));
        const span = document.createElement('span');
        span.textContent = label;
        btn.appendChild(span);
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            handler();
        });
        menu.appendChild(btn);
    }

    addItem(icRename, 'Rename', '', () => actions.rename(conversation));
    addItem(icArchive, conversation.archived ? 'Restore' : 'Archive', '', () => actions.setArchived(conversation, !conversation.archived));

    const sep = document.createElement('div');
    sep.className = 'chat-conv-dropdown-sep';
    menu.appendChild(sep);

    addItem(icDelete, 'Delete', 'is-danger', () => actions.delete(conversation));

    const sep2 = document.createElement('div');
    sep2.className = 'chat-conv-dropdown-sep';
    menu.appendChild(sep2);

    addItem(icSelect, 'Select', '', () => {
        actions.close();
        actions.enterMultiSelectMode(conversation.conversation_id);
    });

    return menu;
}

function positionConversationDropdown(menu, anchorEl) {
    requestAnimationFrame(() => {
        const liveAnchor = document.querySelector('.chat-conv-more-btn.is-open') || anchorEl;
        const rect = liveAnchor.getBoundingClientRect();
        let top = rect.bottom + 4;
        let left = rect.right - menu.offsetWidth;
        if (left < 8) left = 8;
        if (top + menu.offsetHeight > window.innerHeight - 8) {
            top = rect.top - menu.offsetHeight - 4;
        }
        menu.style.top = top + 'px';
        menu.style.left = left + 'px';
    });
}

function renderSearchResults(resultsEl, results, actions) {
    if (!resultsEl) return;
    resultsEl.textContent = '';
    if (results.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-search-result-empty';
        empty.textContent = 'No results found.';
        resultsEl.appendChild(empty);
        return;
    }

    results.forEach((conversation) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'chat-search-result-item';
        if (conversation.archived) el.classList.add('is-archived');

        const name = document.createElement('span');
        name.className = 'chat-search-result-name';
        name.textContent = capitalizeFirst(conversation.title) || 'New conversation';
        el.appendChild(name);

        if (conversation.archived) {
            const badge = document.createElement('span');
            badge.className = 'chat-search-result-badge';
            badge.textContent = 'Archived';
            el.appendChild(badge);

            const restoreBtn = document.createElement('button');
            restoreBtn.type = 'button';
            restoreBtn.className = 'chat-search-restore-btn';
            restoreBtn.textContent = 'Restore';
            restoreBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await actions.restore(conversation);
            });
            el.appendChild(restoreBtn);
        }

        const date = document.createElement('span');
        date.className = 'chat-search-result-date';
        date.textContent = formatConversationTimestamp(conversation.updated_at);
        el.appendChild(date);

        el.addEventListener('click', () => actions.open(conversation));
        resultsEl.appendChild(el);
    });
}

window.HomunChatConversations = {
    buildConversationItem,
    buildConversationDropdown,
    capitalizeFirst,
    conversationApi,
    conversationResourceUrl,
    formatConversationTimestamp,
    groupConversationsByDate,
    parseSvg,
    positionConversationDropdown,
    renderConversationList,
    renderSearchResults,
    setConversationUrl,
    truncateConversationText,
};
