// Homun - progressive assistant response streaming controller.

(() => {
    function createStreamingController(options) {
        const renderIntervalMs = options.renderIntervalMs || 150;
        let streamingEl = null;
        let streamingContent = '';
        let streamRenderRafId = null;
        let lastStreamRenderTime = 0;

        function getElement() {
            return streamingEl;
        }

        function getContent() {
            return streamingContent;
        }

        function clearState() {
            streamingEl = null;
            streamingContent = '';
            lastStreamRenderTime = 0;
        }

        function startFromElement(el) {
            streamingEl = el;
            streamingContent = '';
            lastStreamRenderTime = 0;
        }

        function removeCurrentIfEmpty() {
            if (!streamingEl) return false;
            if (!streamingContent.trim() && !streamingEl.textContent.trim()) {
                streamingEl.remove();
                clearState();
                return true;
            }
            return false;
        }

        function renderStreamingMarkdown() {
            if (!streamingEl || !streamingContent) return;
            let content = streamingContent;

            const fenceCount = (content.match(/^`{3,}/gm) || []).length;
            if (fenceCount % 2 !== 0) content += '\n```';

            const inlineCount = (content.match(/(?<!`)`(?!`)/g) || []).length;
            if (inlineCount % 2 !== 0) content += '`';

            const bodyEl = streamingEl.querySelector('.chat-msg-body') || streamingEl;

            if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
                bodyEl.textContent = streamingContent;
                return;
            }

            const rawHtml = marked.parse(content);
            bodyEl.innerHTML = DOMPurify.sanitize(rawHtml);
        }

        function scheduleRender() {
            const now = Date.now();
            if (now - lastStreamRenderTime >= renderIntervalMs) {
                renderStreamingMarkdown();
                lastStreamRenderTime = now;
            } else if (!streamRenderRafId) {
                streamRenderRafId = requestAnimationFrame(() => {
                    streamRenderRafId = null;
                    if (Date.now() - lastStreamRenderTime >= renderIntervalMs) {
                        renderStreamingMarkdown();
                        lastStreamRenderTime = Date.now();
                    }
                });
            }
        }

        function cancelRender() {
            if (streamRenderRafId) {
                cancelAnimationFrame(streamRenderRafId);
                streamRenderRafId = null;
            }
            lastStreamRenderTime = 0;
        }

        function handleChunk(delta) {
            if (!delta) return;
            options.purgeOrphanLiveArtifacts();

            if (!streamingEl) {
                streamingEl = document.createElement('div');
                streamingEl.className = 'chat-msg assistant streaming';
                const body = document.createElement('div');
                body.className = 'chat-msg-body';
                streamingEl.appendChild(body);
                streamingContent = '';
                lastStreamRenderTime = 0;
                options.messagesEl.appendChild(streamingEl);
            }

            streamingContent += delta;
            scheduleRender();
            options.scrollThreadToBottom();
        }

        function settle() {
            cancelRender();
            options.purgeOrphanLiveArtifacts();
            if (streamingEl) {
                if (streamingContent.trim()) {
                    const bodyEl = streamingEl.querySelector('.chat-msg-body') || streamingEl;
                    options.renderContent(bodyEl, streamingContent, 'assistant');
                    streamingEl.classList.remove('streaming');
                } else {
                    streamingEl.remove();
                }
                clearState();
            }
        }

        function finalize(content, pendingBlocks) {
            cancelRender();

            if (streamingEl) {
                const bodyEl = streamingEl.querySelector('.chat-msg-body') || streamingEl;
                options.renderContent(bodyEl, content, 'assistant');
                if (pendingBlocks && pendingBlocks.length && typeof options.renderBlocks === 'function') {
                    options.renderBlocks(pendingBlocks, bodyEl, options.sendBlockResponse);
                }
                streamingEl.classList.remove('streaming');
                clearState();
            } else {
                options.addMessage('assistant', content, null, { blocks: pendingBlocks });
            }
            options.scrollThreadToBottom();
        }

        return {
            getElement,
            getContent,
            startFromElement,
            removeCurrentIfEmpty,
            clearState,
            handleChunk,
            settle,
            finalize,
        };
    }

    window.HomunChatStreaming = {
        createStreamingController,
    };
})();
