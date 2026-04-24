// Homun — chat markdown rendering and image lightbox helpers.

if (typeof marked !== 'undefined') {
    marked.setOptions({ breaks: true, gfm: true });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** Open a full-screen lightbox for an image. */
function openImageLightbox(src, alt) {
    let overlay = document.getElementById('chat-lightbox');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'chat-lightbox';
        overlay.className = 'chat-lightbox';
        overlay.addEventListener('click', () => { overlay.hidden = true; });
        document.body.appendChild(overlay);
    }
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt || '';
    overlay.textContent = '';
    overlay.appendChild(img);
    overlay.hidden = false;
}

/** Render markdown content safely into an element.
 *  User messages stay plain text; assistant messages get markdown.
 *  Uses DOMPurify to sanitize HTML output from marked.js.
 */
function renderContent(el, content, role) {
    if (role === 'assistant' && typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
        let processedContent = content.replace(
            /\/api\/v1\/browser\/screenshots\/(\S+\.png)/g,
            '\n\n![Screenshot](/api/v1/browser/screenshots/$1)\n\n'
        );

        const rawHtml = marked.parse(processedContent);
        const sanitized = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target'] });
        el.innerHTML = sanitized;

        el.querySelectorAll('a[href]').forEach(a => {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
        });

        el.querySelectorAll('img').forEach(img => {
            img.style.cursor = 'zoom-in';
            img.addEventListener('click', () => openImageLightbox(img.src, img.alt));
        });

        if (typeof hljs !== 'undefined') {
            el.querySelectorAll('pre code').forEach(block => {
                hljs.highlightElement(block);
            });
        }

        el.querySelectorAll('pre').forEach(pre => {
            if (pre.querySelector('.chat-code-copy-btn')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chat-code-copy-btn';
            btn.textContent = 'Copy';
            btn.addEventListener('click', () => {
                const code = pre.querySelector('code');
                navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
            pre.style.position = 'relative';
            pre.appendChild(btn);
        });
    } else if (role === 'user' && typeof DOMPurify !== 'undefined') {
        let html = escapeHtml(content);
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        el.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['code', 'strong', 'em'] });
    } else {
        el.textContent = content;
    }
}

window.HomunChatRendering = {
    escapeHtml,
    renderContent,
    openImageLightbox,
};
