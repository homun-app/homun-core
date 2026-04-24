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

window.HomunChatConversations = {
    capitalizeFirst,
    conversationApi,
    conversationResourceUrl,
    formatConversationTimestamp,
    groupConversationsByDate,
    parseSvg,
    setConversationUrl,
    truncateConversationText,
};
