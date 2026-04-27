// Homun - chat tool/reasoning rendering helpers.

(() => {
    function truncateText(str, maxLen) {
        if (!str) return '';
        return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
    }

    function summarizeUrl(url) {
        if (!url) return '';
        try {
            const parsed = new URL(String(url));
            return parsed.hostname.replace(/^www\./, '');
        } catch (_) {
            return truncateText(String(url), 30);
        }
    }

    function prettifyToolName(name) {
        if (!name) return 'Used a tool';
        return String(name)
            .split(/[_-]+/)
            .filter(Boolean)
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    function reasoningHeadline(reasoningTools) {
        if (reasoningTools.some((name) => name === 'web_search' || name === 'web_fetch' || name === 'browser')) {
            return 'Searched the web';
        }
        if (reasoningTools.some((name) => name === 'shell')) {
            return 'Ran commands';
        }
        if (reasoningTools.length > 0) {
            return 'Used tools';
        }
        return 'Tool activity';
    }

    function describeToolCall(toolCallData) {
        const args = toolCallData.arguments || {};
        const name = toolCallData.name || 'tool';

        if (name === 'web_search') {
            return {
                label: 'Searched the web',
                detail: args.query ? `"${truncateText(String(args.query), 40)}"` : '',
            };
        }

        if (name === 'web_fetch') {
            return {
                label: 'Opened a source',
                detail: summarizeUrl(args.url),
            };
        }

        if (name === 'browser') {
            const action = args.action ? String(args.action) : '';
            if (action === 'navigate') {
                return { label: 'Opened a page', detail: summarizeUrl(args.url) };
            }
            if (action === 'click') {
                return { label: 'Followed a result', detail: args.ref ? `[${args.ref}]` : '' };
            }
            if (action === 'type') {
                return {
                    label: 'Typed into the page',
                    detail: args.text ? `"${truncateText(String(args.text), 40)}"` : '',
                };
            }
            if (action === 'snapshot') {
                return { label: 'Read the page', detail: '' };
            }
            return { label: 'Used the browser', detail: action || '' };
        }

        if (name === 'shell') {
            return {
                label: 'Ran a command',
                detail: args.command ? truncateText(String(args.command), 40) : '',
            };
        }

        if (name === 'subagent') {
            return {
                label: 'Background task',
                detail: args.task ? truncateText(String(args.task), 50) : '',
            };
        }

        return {
            label: prettifyToolName(name),
            detail: '',
        };
    }

    function toolStatusLabel(toolName, args) {
        if (toolName === 'web_search') return 'Ricerca web in corso';
        if (toolName === 'browser') {
            const action = args && args.action ? String(args.action) : '';
            if (action === 'navigate') return 'Navigazione browser in corso';
            if (action === 'snapshot') return 'Lettura pagina in corso';
            return 'Browser in corso';
        }
        if (toolName === 'web_fetch') return 'Apertura fonte in corso';
        if (toolName === 'shell') return 'Esecuzione comandi in corso';
        return `Uso ${toolName} in corso`;
    }

    function buildReasoningNote(text) {
        const note = document.createElement('div');
        note.className = 'chat-tool-call-card';
        const compact = document.createElement('div');
        compact.className = 'chat-tool-call-compact';
        compact.style.opacity = '0.7';
        compact.style.fontStyle = 'italic';
        compact.textContent = text.length > 120 ? text.substring(0, 120) + '...' : text;
        note.appendChild(compact);
        return note;
    }

    function buildToolCallCard(toolCallData) {
        const card = document.createElement('div');
        card.className = 'chat-tool-call';
        card.id = `tool-call-${toolCallData.id}`;
        card.dataset.toolName = toolCallData.name || '';
        card.dataset.toolStatus = 'running';

        const description = describeToolCall(toolCallData);
        card.innerHTML = '<div class="chat-tool-call-compact">' +
            '<span class="chat-tool-call-name">' + window.HomunChatRendering.escapeHtml(description.label) + '</span>' +
            (description.detail ? '<span class="chat-tool-summary">' + window.HomunChatRendering.escapeHtml(description.detail) + '</span>' : '') +
            '<span class="chat-tool-call-meta">Running</span>' +
            '</div>';
        return card;
    }

    function markToolCallComplete(card, toolCallData) {
        card.classList.add('is-complete');
        card.dataset.toolStatus = 'done';
        const meta = card.querySelector('.chat-tool-call-meta');
        if (!meta) return;

        const resultText = toolCallData?.result;
        if (!resultText) {
            meta.textContent = '\u2713';
            return;
        }

        meta.textContent = '\u2713';
        meta.title = resultText;
        const summary = document.createElement('span');
        summary.className = 'chat-tool-summary';
        const downloadMatch = resultText.match(/Download: (\/api\/v1\/workspace\/files\/\S+)/);
        if (downloadMatch) {
            const cleanResult = resultText.split('\nDownload:')[0];
            summary.textContent = cleanResult.length > 80
                ? cleanResult.substring(0, 80) + '...'
                : cleanResult;
            const dlLink = document.createElement('a');
            dlLink.href = downloadMatch[1];
            dlLink.className = 'chat-tool-download';
            dlLink.textContent = ' Download';
            dlLink.target = '_blank';
            dlLink.setAttribute('download', '');
            summary.appendChild(dlLink);
        } else {
            summary.textContent = resultText.length > 80
                ? resultText.substring(0, 80) + '...'
                : resultText;
        }
        const compact = card.querySelector('.chat-tool-call-compact');
        if (compact) compact.appendChild(summary);
    }

    window.HomunChatTools = {
        buildReasoningNote,
        buildToolCallCard,
        markToolCallComplete,
        reasoningHeadline,
        toolStatusLabel,
    };
})();
