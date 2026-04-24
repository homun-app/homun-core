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

window.HomunChatConversations = {
    buildConversationItem,
    capitalizeFirst,
    conversationApi,
    conversationResourceUrl,
    formatConversationTimestamp,
    groupConversationsByDate,
    parseSvg,
    setConversationUrl,
    truncateConversationText,
};
