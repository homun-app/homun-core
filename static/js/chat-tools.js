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

    function compactCognitionLabel(raw) {
        if (!raw || raw.length < 60) return raw || 'Analysis complete';
        const toolsMatch = raw.match(/Tools:\s*([^|]+)/);
        const planMatch = raw.match(/Plan:\s*(\d+)\s*steps?/);
        const parts = [];
        if (toolsMatch) {
            const names = toolsMatch[1].trim().split(/,\s*/);
            parts.push(names.length + ' tool' + (names.length > 1 ? 's' : ''));
        }
        if (planMatch) parts.push(planMatch[1] + ' steps');
        if (raw.includes('Memory: loaded')) parts.push('memory');
        if (parts.length > 0) return 'Analyzed \u00b7 ' + parts.join(', ');
        return raw.length > 50 ? raw.substring(0, 50) + '\u2026' : raw;
    }

    function friendlyCognitionStep(raw) {
        if (raw.startsWith('discover_tools')) return 'Searching tools...';
        if (raw.startsWith('discover_skills')) return 'Searching skills...';
        if (raw.startsWith('discover_mcp')) return 'Checking services...';
        if (raw.startsWith('search_memory')) return 'Checking memory...';
        if (raw.startsWith('search_knowledge')) return 'Searching knowledge...';
        return raw;
    }

    function cleanToolNames(text) {
        return text.replace(/\b[\w-]+__(\w+)/g, '$1');
    }

    function formatCognitionStep(raw) {
        const arrowIdx = raw.indexOf('\u2192');
        if (arrowIdx === -1) return raw;
        const result = raw.substring(arrowIdx + 1).trim();
        if (raw.startsWith('discover_tools')) return 'Tools: ' + cleanToolNames(result);
        if (raw.startsWith('discover_skills')) return 'Skills: ' + result;
        if (raw.startsWith('discover_mcp')) return 'Services: ' + cleanToolNames(result);
        if (raw.startsWith('search_memory')) return 'Memory: ' + result;
        if (raw.startsWith('search_knowledge')) return 'Knowledge: ' + result;
        return raw;
    }

    function createActivityController(options) {
        let cognitionEl = null;
        let thinkingEl = null;
        let thinkingContent = '';

        function getThinkingElement() {
            return thinkingEl;
        }

        function getThinkingContent() {
            return thinkingContent;
        }

        function clearThinkingState() {
            thinkingEl = null;
            thinkingContent = '';
        }

        function showCognitionStep(label) {
            if (!cognitionEl) {
                cognitionEl = document.createElement('div');
                cognitionEl.className = 'chat-cognition is-active';

                const header = document.createElement('div');
                header.className = 'chat-cognition-header';
                header.onclick = function () { window.toggleCognition(this); };

                const dot = document.createElement('span');
                dot.className = 'chat-cognition-dot';
                const lbl = document.createElement('span');
                lbl.className = 'chat-cognition-label';
                const toggle = document.createElement('span');
                toggle.className = 'chat-cognition-toggle';
                toggle.textContent = '\u203A';

                header.append(dot, lbl, toggle);

                const steps = document.createElement('div');
                steps.className = 'chat-cognition-steps';

                cognitionEl.append(header, steps);
                options.messagesEl.appendChild(cognitionEl);
                options.scrollThreadToBottom();
            }
            const labelEl = cognitionEl.querySelector('.chat-cognition-label');
            if (labelEl) labelEl.textContent = label;
        }

        function addCognitionStep(step) {
            if (!cognitionEl) showCognitionStep('Analyzing...');
            const stepsEl = cognitionEl.querySelector('.chat-cognition-steps');
            if (!stepsEl) return;
            const stepEl = document.createElement('div');
            stepEl.className = 'chat-cognition-step';
            stepEl.textContent = formatCognitionStep(step);
            stepsEl.appendChild(stepEl);
            const labelEl = cognitionEl.querySelector('.chat-cognition-label');
            if (labelEl) labelEl.textContent = friendlyCognitionStep(step);
            options.scrollThreadToBottom();
        }

        function finalizeCognition(summary) {
            if (!cognitionEl) showCognitionStep(summary);
            cognitionEl.classList.remove('is-active');
            cognitionEl.classList.add('collapsed');
            const labelEl = cognitionEl.querySelector('.chat-cognition-label');
            if (labelEl) labelEl.textContent = compactCognitionLabel(summary);
        }

        function removeCognition() {
            if (cognitionEl) {
                cognitionEl.remove();
                cognitionEl = null;
            }
        }

        function createThinkingBlock() {
            options.purgeOrphanLiveArtifacts();
            if (thinkingEl) return thinkingEl;

            thinkingEl = document.createElement('div');
            thinkingEl.className = 'chat-thinking collapsed';
            thinkingEl.innerHTML = `
                <div class="chat-thinking-header" onclick="toggleThinking(this)">
                    <span class="chat-thinking-label">Thinking</span>
                    <span class="chat-thinking-toggle">\u203A</span>
                </div>
                <div class="chat-thinking-content"></div>
            `;

            const toolIndicatorEl = options.getToolIndicator();
            if (toolIndicatorEl && toolIndicatorEl.parentElement === options.messagesEl) {
                options.messagesEl.insertBefore(thinkingEl, toolIndicatorEl);
            } else {
                options.messagesEl.appendChild(thinkingEl);
            }
            options.scrollThreadToBottom();

            return thinkingEl;
        }

        function appendThinking(delta) {
            if (!thinkingEl) createThinkingBlock();

            thinkingContent += delta;
            thinkingEl.classList.add('has-content', 'is-live');
            const contentEl = thinkingEl.querySelector('.chat-thinking-content');
            if (contentEl) {
                contentEl.textContent = thinkingContent;
            }

            options.scrollThreadToBottom();
        }

        function finalizeThinking() {
            if (thinkingEl && thinkingContent) {
                thinkingEl.classList.remove('collapsed');
                thinkingEl.classList.remove('is-live');
                thinkingEl.classList.add('has-content');

                if (thinkingContent.length > 200) {
                    thinkingEl.classList.add('collapsed');
                }
            }
            clearThinkingState();
        }

        return {
            addCognitionStep,
            appendThinking,
            clearThinkingState,
            createThinkingBlock,
            finalizeCognition,
            finalizeThinking,
            getThinkingContent,
            getThinkingElement,
            removeCognition,
            showCognitionStep,
        };
    }

    window.toggleCognition = function (headerEl) {
        const section = headerEl.closest('.chat-cognition');
        if (section) section.classList.toggle('collapsed');
    };

    window.toggleThinking = function (headerEl) {
        const thinkingBlock = headerEl.closest('.chat-thinking');
        if (thinkingBlock) {
            thinkingBlock.classList.toggle('collapsed');
        }
    };

    window.HomunChatTools = {
        buildReasoningNote,
        buildToolCallCard,
        createActivityController,
        markToolCallComplete,
        reasoningHeadline,
        toolStatusLabel,
    };
})();
