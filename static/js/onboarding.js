// Homun — Onboarding v3: WordPress-style 5-step setup wizard
// Full-page, no sidebar. Steps: Account → Provider → Persona → Channels → Ready.
//
// Security: all dynamic content is sanitized via esc() before DOM insertion.
// No user input is ever inserted raw — only escaped strings from trusted constants
// or API responses. This follows the same pattern as the existing codebase
// (chat.js, channels.js, account-gateways.js) which use the same setHTML pattern.

(function () {
    'use strict';

    var STEPS = ['account', 'provider', 'persona', 'channels', 'ready'];
    var STEP_LABELS = {
        account: 'Step 1 of 5 — Account',
        provider: 'Step 2 of 5 — LLM Provider',
        persona: 'Step 3 of 5 — Your Assistant',
        channels: 'Step 4 of 5 — Channels',
        ready: 'Step 5 of 5 — Ready!',
    };

    var currentStep = 0;
    var state = {
        hasAccount: false,
        providerKey: null,
        modelSelected: '',
        ollamaDetected: false,
        ollamaModels: [],
        profileGenerated: false,
        gatewaysCreated: 0,
    };

    // ═══ Helpers ═══

    // Sanitize string for safe DOM insertion (XSS prevention).
    function esc(str) {
        var d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML; // safe: textContent escapes all HTML
    }

    function $(id) { return document.getElementById(id); }

    // Set element HTML from trusted, pre-escaped content.
    // All callers ensure values are escaped via esc() or are static constants.
    function setHTML(el, trustedHtml) { if (el) el.innerHTML = trustedHtml; }

    async function patchConfig(key, value) {
        await fetch('/api/v1/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: key, value: value }),
        });
    }

    // ═══ Constants ═══

    var PROVIDERS = {
        anthropic:   { name: 'Anthropic',      icon: '\uD83D\uDFE0', color: '#D97706', hint: 'Claude models \u2014 best for complex reasoning' },
        openai:      { name: 'OpenAI',          icon: '\uD83D\uDFE2', color: '#10A37F', hint: 'GPT models \u2014 versatile and fast' },
        ollama:      { name: 'Ollama (local)',   icon: '\uD83E\uDD99', color: '#888888', hint: 'Run models locally \u2014 free, private' },
        ollama_cloud:{ name: 'Ollama Cloud',     icon: '\u2601\uFE0F', color: '#6366F1', hint: 'Cloud-hosted Ollama \u2014 easy setup' },
        openrouter:  { name: 'OpenRouter',       icon: '\uD83D\uDD00', color: '#6366F1', hint: 'Access 200+ models via one API key' },
        deepseek:    { name: 'DeepSeek',         icon: '\uD83D\uDD35', color: '#0EA5E9', hint: 'DeepSeek V3/R1 \u2014 high quality, affordable' },
        groq:        { name: 'Groq',             icon: '\u26A1',       color: '#F97316', hint: 'Ultra-fast inference on open models' },
        gemini:      { name: 'Google Gemini',    icon: '\uD83D\uDC8E', color: '#4285F4', hint: 'Gemini Pro/Flash \u2014 Google AI' },
    };

    var CHANNEL_TYPES = [
        { key: 'telegram',  name: 'Telegram',  icon: '\u2708\uFE0F', hasToken: true,  hint: 'Create a bot with @BotFather' },
        { key: 'whatsapp',  name: 'WhatsApp',  icon: '\uD83D\uDCF1', hasToken: false, hint: 'Pair via phone number' },
        { key: 'discord',   name: 'Discord',   icon: '\uD83C\uDFAE', hasToken: true,  hint: 'Create app at discord.com/developers' },
        { key: 'slack',     name: 'Slack',      icon: '\uD83D\uDCAC', hasToken: true,  hint: 'Create app at api.slack.com/apps' },
        { key: 'email',     name: 'Email',      icon: '\u2709\uFE0F', hasToken: false, hint: 'IMAP/SMTP \u2014 for Gmail use App Passwords' },
    ];

    var ACCENT_PRESETS = [
        { color: '#3B82F6', label: 'Blue' },
        { color: '#B85C38', label: 'Moss' },
        { color: '#C96D47', label: 'Terra' },
        { color: '#8B5CF6', label: 'Plum' },
        { color: '#78716C', label: 'Stone' },
    ];

    // ═══ Navigation ═══

    function render() {
        var bar = $('ob-progress-bar');
        if (bar) bar.style.width = ((currentStep + 1) / STEPS.length * 100) + '%';

        var label = $('ob-step-label');
        if (label) label.textContent = STEP_LABELS[STEPS[currentStep]] || '';

        var main = $('ob-main');
        if (!main) return;

        switch (STEPS[currentStep]) {
            case 'account':  setHTML(main, renderAccount()); bindAccount(); break;
            case 'provider': setHTML(main, renderProvider()); bindProvider(); break;
            case 'persona':  setHTML(main, renderPersona()); bindPersona(); break;
            case 'channels': setHTML(main, renderChannels()); bindChannels(); break;
            case 'ready':    setHTML(main, renderReady()); break;
        }

        updateNav();
    }

    function updateNav() {
        var back = $('ob-back');
        var next = $('ob-next');
        if (!back || !next) return;

        back.style.visibility = currentStep === 0 ? 'hidden' : 'visible';

        if (currentStep === STEPS.length - 1) {
            next.textContent = 'Start chatting \u2192';
        } else if (currentStep === 0 && !state.hasAccount) {
            next.textContent = 'Create account \u2192';
        } else {
            next.textContent = 'Continue \u2192';
        }
    }

    async function goNext() {
        var step = STEPS[currentStep];

        if (step === 'account') {
            if (!(await saveAccount())) return;
        } else if (step === 'provider') {
            if (!(await saveProvider())) return;
        } else if (step === 'persona') {
            await savePersona();
        } else if (step === 'channels') {
            // Channels are optional
        } else if (step === 'ready') {
            await completeOnboarding();
            return;
        }

        if (currentStep < STEPS.length - 1) {
            currentStep++;
            render();
            window.scrollTo(0, 0);
        }
    }

    function goBack() {
        if (currentStep > 0) {
            currentStep--;
            render();
            window.scrollTo(0, 0);
        }
    }

    // ═══ Step 1: Account ═══

    function renderAccount() {
        var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        var savedLang = localStorage.getItem('homun-language') || 'en';

        if (state.hasAccount) {
            return '<h2>Welcome back</h2>' +
                '<p class="ob-subtitle">Your admin account is already set up. Adjust these settings if needed.</p>' +
                '<div class="ob-form-row">' +
                    '<div class="ob-form-group"><label>Language</label>' +
                        '<select id="ob-lang" class="ob-input"><option value="en"' + (savedLang === 'en' ? ' selected' : '') + '>English</option>' +
                        '<option value="it"' + (savedLang === 'it' ? ' selected' : '') + '>Italiano</option></select></div>' +
                    '<div class="ob-form-group"><label>Timezone</label>' +
                        '<input type="text" id="ob-tz" class="ob-input" value="' + esc(tz) + '"></div>' +
                '</div>' +
                '<div id="ob-account-error" class="ob-form-error"></div>';
        }

        return '<h2>Create your account</h2>' +
            '<p class="ob-subtitle">Set up the admin account for your Homun instance.</p>' +
            '<div class="ob-form-group"><label>Username</label>' +
                '<input type="text" id="ob-username" class="ob-input" placeholder="admin" autocomplete="username" value="admin"></div>' +
            '<div class="ob-form-row">' +
                '<div class="ob-form-group"><label>Password</label>' +
                    '<input type="password" id="ob-password" class="ob-input" placeholder="Choose a strong password" autocomplete="new-password"></div>' +
                '<div class="ob-form-group"><label>Confirm password</label>' +
                    '<input type="password" id="ob-password2" class="ob-input" placeholder="Repeat password" autocomplete="new-password"></div>' +
            '</div>' +
            '<div class="ob-form-row">' +
                '<div class="ob-form-group"><label>Language</label>' +
                    '<select id="ob-lang" class="ob-input"><option value="en"' + (savedLang === 'en' ? ' selected' : '') + '>English</option>' +
                    '<option value="it"' + (savedLang === 'it' ? ' selected' : '') + '>Italiano</option></select></div>' +
                '<div class="ob-form-group"><label>Timezone</label>' +
                    '<input type="text" id="ob-tz" class="ob-input" value="' + esc(tz) + '"></div>' +
            '</div>' +
            '<div id="ob-account-error" class="ob-form-error"></div>';
    }

    function bindAccount() {
        ['ob-password', 'ob-password2'].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener('keydown', function (e) { if (e.key === 'Enter') goNext(); });
        });
    }

    async function saveAccount() {
        var errEl = $('ob-account-error');
        if (errEl) errEl.textContent = '';

        if (!state.hasAccount) {
            var username = ($('ob-username') || {}).value || '';
            var pw1 = ($('ob-password') || {}).value || '';
            var pw2 = ($('ob-password2') || {}).value || '';

            if (!username.trim()) { if (errEl) errEl.textContent = 'Username is required'; return false; }
            if (pw1.length < 6) { if (errEl) errEl.textContent = 'Password must be at least 6 characters'; return false; }
            if (pw1 !== pw2) { if (errEl) errEl.textContent = 'Passwords do not match'; return false; }

            try {
                var resp = await fetch('/api/auth/setup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username.trim(), password: pw1 }),
                });
                if (!resp.ok) {
                    var data = await resp.json().catch(function () { return {}; });
                    if (errEl) errEl.textContent = data.error || 'Failed to create account';
                    return false;
                }
                state.hasAccount = true;
            } catch (e) {
                if (errEl) errEl.textContent = 'Network error';
                return false;
            }
        }

        var lang = ($('ob-lang') || {}).value || 'en';
        var tz = ($('ob-tz') || {}).value || 'UTC';
        localStorage.setItem('homun-language', lang);
        await patchConfig('ui.language', lang);
        await patchConfig('agent.timezone', tz);
        return true;
    }

    // ═══ Step 2: Provider ═══

    function renderProvider() {
        var cards = Object.keys(PROVIDERS).map(function (key) {
            var p = PROVIDERS[key];
            var selected = state.providerKey === key;
            return '<div class="ob-card' + (selected ? ' is-selected' : '') + '" data-provider="' + esc(key) + '">' +
                '<span class="ob-card-icon">' + p.icon + '</span>' +
                '<span class="ob-card-name">' + esc(p.name) + '</span>' +
            '</div>';
        }).join('');

        return '<h2>Choose your LLM provider</h2>' +
            '<p class="ob-subtitle">Select an AI provider and configure your API key. You can change this later.</p>' +
            '<div class="ob-card-grid">' + cards + '</div>' +
            '<div id="ob-provider-expand"></div>' +
            '<div id="ob-model-section" style="display:none">' +
                '<h3 style="margin:20px 0 8px;font-size:1rem;font-weight:600">Select a model</h3>' +
                '<div id="ob-model-list" class="ob-model-list"></div>' +
            '</div>';
    }

    function bindProvider() {
        document.querySelectorAll('.ob-card[data-provider]').forEach(function (card) {
            card.addEventListener('click', function () {
                document.querySelectorAll('.ob-card[data-provider]').forEach(function (c) { c.classList.remove('is-selected'); });
                card.classList.add('is-selected');
                state.providerKey = card.dataset.provider;
                expandProviderForm(card.dataset.provider);
            });
        });
        if (state.providerKey) expandProviderForm(state.providerKey);
    }

    function expandProviderForm(key) {
        var container = $('ob-provider-expand');
        if (!container) return;
        var p = PROVIDERS[key];

        if (key === 'ollama') {
            setHTML(container, '<div class="ob-expand">' +
                '<div class="ob-expand-title">' + p.icon + ' ' + esc(p.name) + '</div>' +
                '<p class="ob-form-hint">' + esc(p.hint) + '</p>' +
                '<div id="ob-ollama-status" class="ob-form-hint">Detecting Ollama on localhost:11434\u2026</div>' +
            '</div>');
            detectOllama();
            return;
        }

        var apiLabel = key === 'ollama_cloud' ? 'Ollama Cloud API Key' : 'API Key';
        var signupHint = key === 'ollama_cloud'
            ? '<div class="ob-form-hint">Get a free key at <a href="https://ollama.com/account" target="_blank" rel="noopener" style="color:var(--accent)">ollama.com/account</a></div>'
            : '';

        setHTML(container, '<div class="ob-expand">' +
            '<div class="ob-expand-title">' + p.icon + ' ' + esc(p.name) + '</div>' +
            '<p class="ob-form-hint" style="margin-bottom:12px">' + esc(p.hint) + '</p>' +
            signupHint +
            '<div class="ob-form-group"><label>' + esc(apiLabel) + '</label>' +
                '<input type="password" id="ob-api-key" class="ob-input" placeholder="Paste your API key"></div>' +
            '<div style="display:flex;gap:8px;align-items:center">' +
                '<button class="btn btn-primary btn-sm" id="ob-test-key">Test &amp; Save</button>' +
                '<span id="ob-test-result"></span>' +
            '</div>' +
        '</div>');

        $('ob-test-key').addEventListener('click', function () { testAndSaveProvider(key); });
        $('ob-api-key').addEventListener('keydown', function (e) { if (e.key === 'Enter') testAndSaveProvider(key); });
    }

    async function testAndSaveProvider(key) {
        var apiKey = ($('ob-api-key') || {}).value.trim();
        var resultEl = $('ob-test-result');
        if (!apiKey) { if (resultEl) setHTML(resultEl, '<span class="ob-badge ob-badge-err">Enter an API key</span>'); return; }
        if (resultEl) setHTML(resultEl, '<span class="ob-badge ob-badge-wait">Testing\u2026</span>');

        var configKey = key === 'ollama_cloud' ? 'providers.ollama_cloud.api_key' : 'providers.' + key + '.api_key';
        await patchConfig(configKey, apiKey);

        try {
            var resp = await fetch('/api/v1/providers/' + encodeURIComponent(key) + '/test', { method: 'POST' });
            if (resp.ok) {
                if (resultEl) setHTML(resultEl, '<span class="ob-badge ob-badge-ok">\u2713 Connected</span>');
                loadModels(key);
            } else {
                if (resultEl) setHTML(resultEl, '<span class="ob-badge ob-badge-err">\u2717 Failed \u2014 check your key</span>');
            }
        } catch (e) {
            if (resultEl) setHTML(resultEl, '<span class="ob-badge ob-badge-err">\u2717 Network error</span>');
        }
    }

    async function detectOllama() {
        var statusEl = $('ob-ollama-status');
        try {
            var resp = await fetch('/api/v1/providers/ollama/models');
            if (resp.ok) {
                var data = await resp.json();
                state.ollamaDetected = true;
                state.ollamaModels = (data.models || []).map(function (m) { return m.id || m.name; });
                if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-ok">\u2713 Ollama detected \u2014 ' + state.ollamaModels.length + ' models</span>');
                loadModels('ollama');
            } else {
                if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Ollama not found. <a href="https://ollama.ai" target="_blank" rel="noopener" style="color:var(--accent)">Install Ollama</a></span>');
            }
        } catch (e) {
            if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Cannot reach Ollama</span>');
        }
    }

    async function loadModels(providerKey) {
        var section = $('ob-model-section');
        var listEl = $('ob-model-list');
        if (!section || !listEl) return;

        var endpoint = providerKey === 'ollama' ? '/api/v1/providers/ollama/models'
            : providerKey === 'ollama_cloud' ? '/api/v1/providers/ollama-cloud/models'
            : '/api/v1/providers/models';

        try {
            var resp = await fetch(endpoint);
            if (!resp.ok) return;
            var data = await resp.json();
            var models = data.models || data || [];
            var prefix = providerKey === 'ollama' ? 'ollama/' : providerKey === 'ollama_cloud' ? 'ollama_cloud/' : providerKey + '/';
            var filtered = models.filter(function (m) {
                var id = m.id || m.name || m;
                return typeof id === 'string' && id.startsWith(prefix);
            }).slice(0, 15);

            if (filtered.length === 0) { section.style.display = 'none'; return; }

            section.style.display = 'block';
            setHTML(listEl, filtered.map(function (m) {
                var id = m.id || m.name || m;
                var display = id.replace(prefix, '');
                var selected = state.modelSelected === id;
                return '<label class="ob-model-item' + (selected ? ' is-selected' : '') + '">' +
                    '<input type="radio" name="ob-model" value="' + esc(id) + '"' + (selected ? ' checked' : '') + '>' +
                    '<span class="ob-model-name">' + esc(display) + '</span>' +
                '</label>';
            }).join(''));

            listEl.querySelectorAll('input[name="ob-model"]').forEach(function (radio) {
                radio.addEventListener('change', function () {
                    state.modelSelected = radio.value;
                    listEl.querySelectorAll('.ob-model-item').forEach(function (item) { item.classList.remove('is-selected'); });
                    radio.closest('.ob-model-item').classList.add('is-selected');
                });
            });
        } catch (e) { /* silent */ }
    }

    async function saveProvider() {
        if (!state.modelSelected) {
            var radio = document.querySelector('input[name="ob-model"]:checked');
            if (radio) state.modelSelected = radio.value;
        }
        if (!state.modelSelected && !state.providerKey) {
            var expand = $('ob-provider-expand');
            if (expand && !expand.textContent.trim()) {
                setHTML(expand, '<div class="ob-form-error">Please select a provider and configure your API key.</div>');
            }
            return false;
        }
        if (state.modelSelected) {
            await patchConfig('agent.model', state.modelSelected);
        }
        return true;
    }

    // ═══ Step 3: Persona ═══

    function renderPersona() {
        var curTheme = localStorage.getItem('homun-theme') || 'system';

        var themeButtons = ['system', 'light', 'dark'].map(function (val) {
            var label = val.charAt(0).toUpperCase() + val.slice(1);
            return '<button class="ob-theme-btn' + (curTheme === val ? ' is-active' : '') + '" data-theme="' + val + '">' + esc(label) + '</button>';
        }).join('');

        var curAccent = localStorage.getItem('homun-accent') || '';
        var accentDots = ACCENT_PRESETS.map(function (p) {
            var active = curAccent === p.color || (!curAccent && p.color === '#3B82F6');
            return '<div class="ob-accent-dot' + (active ? ' is-active' : '') + '" data-accent="' + esc(p.color) + '" style="background:' + esc(p.color) + '" title="' + esc(p.label) + '"></div>';
        }).join('');

        return '<h2>Your assistant</h2>' +
            '<p class="ob-subtitle">Give your assistant a personality. Describe what you want and we\'ll generate a profile.</p>' +
            '<div class="ob-form-group"><label>Assistant name</label>' +
                '<input type="text" id="ob-bot-name" class="ob-input" placeholder="Homun" value="Homun"></div>' +
            '<div class="ob-form-group"><label>Describe the personality</label>' +
                '<textarea id="ob-bot-desc" class="ob-input" placeholder="e.g. You are a friendly Italian-speaking personal assistant who helps with work and daily life. Informal tone, concise answers."></textarea>' +
                '<div class="ob-form-hint">Write in natural language. The AI will generate a full profile from this.</div></div>' +
            '<div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">' +
                '<button class="btn btn-primary btn-sm" id="ob-gen-profile">Generate profile</button>' +
                '<span id="ob-gen-status"></span>' +
            '</div>' +
            '<div id="ob-profile-preview"></div>' +
            '<hr style="border:none;border-top:1px solid var(--border);margin:20px 0">' +
            '<div class="ob-form-group"><label>Theme</label>' +
                '<div class="ob-theme-row">' + themeButtons + '</div></div>' +
            '<div class="ob-form-group"><label>Accent color</label>' +
                '<div class="ob-accent-row">' + accentDots +
                    '<input type="color" id="ob-accent-custom" class="ob-accent-dot" style="padding:0;width:28px;height:28px;border-radius:50%;cursor:pointer" title="Custom">' +
                '</div></div>';
    }

    function bindPersona() {
        var genBtn = $('ob-gen-profile');
        if (genBtn) genBtn.addEventListener('click', generateProfile);

        document.querySelectorAll('.ob-theme-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.ob-theme-btn').forEach(function (b) { b.classList.remove('is-active'); });
                btn.classList.add('is-active');
                var theme = btn.dataset.theme;
                localStorage.setItem('homun-theme', theme);
                document.documentElement.classList.toggle('dark',
                    theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches));
            });
        });

        document.querySelectorAll('.ob-accent-dot:not(input)').forEach(function (dot) {
            dot.addEventListener('click', function () {
                document.querySelectorAll('.ob-accent-dot').forEach(function (d) { d.classList.remove('is-active'); });
                dot.classList.add('is-active');
                var color = dot.dataset.accent;
                localStorage.setItem('homun-accent', color);
                document.documentElement.style.setProperty('--accent', color);
            });
        });

        var customColor = $('ob-accent-custom');
        if (customColor) {
            customColor.addEventListener('input', function () {
                document.querySelectorAll('.ob-accent-dot').forEach(function (d) { d.classList.remove('is-active'); });
                customColor.classList.add('is-active');
                localStorage.setItem('homun-accent', customColor.value);
                document.documentElement.style.setProperty('--accent', customColor.value);
            });
        }
    }

    async function generateProfile() {
        var desc = ($('ob-bot-desc') || {}).value.trim();
        var name = ($('ob-bot-name') || {}).value.trim() || 'Homun';
        var statusEl = $('ob-gen-status');
        var previewEl = $('ob-profile-preview');

        if (!desc) { if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Write a description first</span>'); return; }
        if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-wait">Generating\u2026</span>');

        try {
            await fetch('/api/v1/profiles/1', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ display_name: name }),
            });

            var resp = await fetch('/api/v1/profiles/1/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: desc }),
            });

            if (resp.ok) {
                var data = await resp.json();
                state.profileGenerated = true;
                if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-ok">\u2713 Generated</span>');
                if (previewEl) {
                    var emoji = esc(data.avatar_emoji || '\uD83E\uDD16');
                    var soul = esc(data.soul || desc);
                    setHTML(previewEl, '<div class="ob-profile-preview">' +
                        '<div class="ob-profile-header">' +
                            '<span class="ob-profile-avatar">' + emoji + '</span>' +
                            '<span class="ob-profile-name">' + esc(name) + '</span>' +
                        '</div>' +
                        '<div class="ob-profile-soul">' + soul + '</div>' +
                    '</div>');
                }
            } else {
                if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Generation failed \u2014 you can set this up later</span>');
            }
        } catch (e) {
            if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Error: ' + esc(e.message) + '</span>');
        }
    }

    async function savePersona() {
        var name = ($('ob-bot-name') || {}).value.trim() || 'Homun';
        await patchConfig('agent.user_name', name);
        var theme = localStorage.getItem('homun-theme') || 'system';
        await patchConfig('ui.theme', theme);
        var accent = localStorage.getItem('homun-accent') || '';
        if (accent) await patchConfig('ui.accent', accent);
    }

    // ═══ Step 4: Channels ═══

    function renderChannels() {
        var cards = CHANNEL_TYPES.map(function (ch) {
            return '<div class="ob-card" data-channel="' + esc(ch.key) + '">' +
                '<span class="ob-card-icon">' + ch.icon + '</span>' +
                '<span class="ob-card-name">' + esc(ch.name) + '</span>' +
            '</div>';
        }).join('');

        return '<h2>Connect your channels</h2>' +
            '<p class="ob-subtitle">Add messaging channels to talk to your assistant from anywhere. This is optional \u2014 you can always use the Web UI.</p>' +
            '<div class="ob-card-grid">' + cards + '</div>' +
            '<div class="ob-card is-always" style="display:flex;flex-direction:row;padding:12px 16px;gap:12px;min-height:auto">' +
                '<span>\uD83C\uDF10</span><span class="ob-card-name">Web UI</span>' +
                '<span class="ob-badge ob-badge-ok" style="margin-left:auto">Always enabled</span>' +
            '</div>' +
            '<div id="ob-channel-expand" style="margin-top:16px"></div>';
    }

    function bindChannels() {
        document.querySelectorAll('.ob-card[data-channel]').forEach(function (card) {
            card.addEventListener('click', function () { expandChannelForm(card.dataset.channel); });
        });
    }

    function expandChannelForm(channelKey) {
        var container = $('ob-channel-expand');
        if (!container) return;
        var ch = CHANNEL_TYPES.find(function (c) { return c.key === channelKey; });
        if (!ch) return;

        var fields = '';
        if (channelKey === 'telegram') {
            fields = '<div class="ob-form-group"><label>Bot Token</label>' +
                '<input type="password" id="ob-ch-token" class="ob-input" placeholder="Paste token from @BotFather">' +
                '<div class="ob-form-hint">Create a bot with @BotFather on Telegram, then paste the token here.</div></div>' +
                '<div class="ob-form-group"><label>Your Telegram User ID</label>' +
                '<input type="text" id="ob-ch-allow" class="ob-input" placeholder="e.g. 123456789">' +
                '<div class="ob-form-hint">Get your numeric ID from @userinfobot.</div></div>';
        } else if (channelKey === 'discord') {
            fields = '<div class="ob-form-group"><label>Bot Token</label>' +
                '<input type="password" id="ob-ch-token" class="ob-input" placeholder="Paste Discord bot token">' +
                '<div class="ob-form-hint">Create an app at discord.com/developers, enable Message Content intent.</div></div>';
        } else if (channelKey === 'slack') {
            fields = '<div class="ob-form-group"><label>Bot Token (xoxb-...)</label>' +
                '<input type="password" id="ob-ch-token" class="ob-input" placeholder="xoxb-...">' +
                '<div class="ob-form-hint">OAuth &amp; Permissions \u2192 Bot User OAuth Token.</div></div>' +
                '<div class="ob-form-group"><label>App Token (xapp-...)</label>' +
                '<input type="password" id="ob-ch-app-token" class="ob-input" placeholder="xapp-...">' +
                '<div class="ob-form-hint">Basic Information \u2192 App-Level Tokens. Needed for Socket Mode.</div></div>';
        } else if (channelKey === 'whatsapp') {
            fields = '<div class="ob-form-group"><label>Phone number</label>' +
                '<input type="tel" id="ob-ch-phone" class="ob-input" placeholder="393331234567">' +
                '<div class="ob-form-hint">International format without +. Pairing will happen after setup.</div></div>';
        } else if (channelKey === 'email') {
            fields = '<div class="ob-form-row">' +
                '<div class="ob-form-group"><label>IMAP Server</label>' +
                    '<input type="text" id="ob-ch-imap" class="ob-input" placeholder="imap.gmail.com"></div>' +
                '<div class="ob-form-group"><label>SMTP Server</label>' +
                    '<input type="text" id="ob-ch-smtp" class="ob-input" placeholder="smtp.gmail.com"></div>' +
            '</div>' +
            '<div class="ob-form-row">' +
                '<div class="ob-form-group"><label>Email</label>' +
                    '<input type="email" id="ob-ch-email" class="ob-input" placeholder="you@gmail.com"></div>' +
                '<div class="ob-form-group"><label>App Password</label>' +
                    '<input type="password" id="ob-ch-password" class="ob-input" placeholder="App password"></div>' +
            '</div>';
        }

        setHTML(container, '<div class="ob-expand">' +
            '<div class="ob-expand-title">' + ch.icon + ' ' + esc(ch.name) + '</div>' +
            fields +
            '<div style="display:flex;gap:8px;align-items:center;margin-top:12px">' +
                '<button class="btn btn-primary btn-sm" id="ob-ch-save">Save channel</button>' +
                '<span id="ob-ch-status"></span>' +
            '</div>' +
        '</div>');

        $('ob-ch-save').addEventListener('click', function () { saveChannel(channelKey); });
    }

    async function saveChannel(channelKey) {
        var statusEl = $('ob-ch-status');
        if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-wait">Saving\u2026</span>');

        var payload = {
            name: channelKey.charAt(0).toUpperCase() + channelKey.slice(1),
            channel_type: channelKey,
            response_mode: 'automatic',
        };
        var configObj = { enabled: true };

        if (channelKey === 'telegram') {
            var token = ($('ob-ch-token') || {}).value.trim();
            if (!token) { if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Token required</span>'); return; }
            payload.token = token;
            configObj.token = '***ENCRYPTED***';
            var allow = ($('ob-ch-allow') || {}).value.trim();
            if (allow) configObj.allow_from = allow.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else if (channelKey === 'discord') {
            var tkn = ($('ob-ch-token') || {}).value.trim();
            if (!tkn) { if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Token required</span>'); return; }
            payload.token = tkn;
            configObj.token = '***ENCRYPTED***';
        } else if (channelKey === 'slack') {
            var st = ($('ob-ch-token') || {}).value.trim();
            if (!st) { if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Token required</span>'); return; }
            payload.token = st;
            configObj.token = '***ENCRYPTED***';
            var appToken = ($('ob-ch-app-token') || {}).value.trim();
            if (appToken) { payload.app_token = appToken; configObj.app_token = '***ENCRYPTED***'; }
        } else if (channelKey === 'whatsapp') {
            var phone = ($('ob-ch-phone') || {}).value.trim();
            if (!phone) { if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Phone required</span>'); return; }
            configObj.phone_number = phone;
        } else if (channelKey === 'email') {
            var imap = ($('ob-ch-imap') || {}).value.trim();
            var email = ($('ob-ch-email') || {}).value.trim();
            var pw = ($('ob-ch-password') || {}).value.trim();
            if (!imap || !email || !pw) { if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Fill in all fields</span>'); return; }
            var smtp = ($('ob-ch-smtp') || {}).value.trim();
            configObj.imap_host = imap;
            configObj.imap_port = 993;
            configObj.smtp_host = smtp || imap.replace('imap.', 'smtp.');
            configObj.smtp_port = 465;
            configObj.username = email;
            configObj.from_address = email;
            configObj.password = '***ENCRYPTED***';
            payload.token = pw;
        }

        payload.config_json = JSON.stringify(configObj);

        try {
            var resp = await fetch('/api/v1/gateways', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (resp.ok) {
                state.gatewaysCreated++;
                if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-ok">\u2713 Saved</span>');
                var card = document.querySelector('.ob-card[data-channel="' + channelKey + '"]');
                if (card) card.classList.add('is-configured');
            } else {
                var err = await resp.json().catch(function () { return {}; });
                if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">' + esc(err.error || 'Failed') + '</span>');
            }
        } catch (e) {
            if (statusEl) setHTML(statusEl, '<span class="ob-badge ob-badge-err">Network error</span>');
        }
    }

    // ═══ Step 5: Ready ═══

    function renderReady() {
        var model = state.modelSelected || 'Not selected';
        var modelShort = model.split('/').pop() || model;
        var provider = state.providerKey ? (PROVIDERS[state.providerKey] || {}).name || state.providerKey : 'Not selected';
        var channels = state.gatewaysCreated + ' channel' + (state.gatewaysCreated !== 1 ? 's' : '') + ' configured';

        return '<h2>You\'re all set! \uD83C\uDF89</h2>' +
            '<p class="ob-subtitle">Your Homun instance is ready to go.</p>' +
            '<div class="ob-summary">' +
                '<div class="ob-summary-item"><span class="ob-summary-label">Provider</span><span class="ob-summary-value">' + esc(provider) + '</span></div>' +
                '<div class="ob-summary-item"><span class="ob-summary-label">Model</span><span class="ob-summary-value">' + esc(modelShort) + '</span></div>' +
                '<div class="ob-summary-item"><span class="ob-summary-label">Channels</span><span class="ob-summary-value">' + esc(channels) + ' + Web UI</span></div>' +
            '</div>' +
            '<p style="margin-top:24px;color:var(--t3);font-size:0.875rem">You can change all settings anytime from the Settings page.</p>';
    }

    async function completeOnboarding() {
        await fetch('/api/v1/onboarding/complete', { method: 'POST' });
        window.location.href = '/chat';
    }

    // ═══ Init ═══

    async function init() {
        try {
            var resp = await fetch('/api/v1/onboarding/status');
            if (resp.ok) {
                var s = await resp.json();
                state.hasAccount = s.has_account;
                if (s.has_model) {
                    state.modelSelected = s.model;
                    var prefix = s.model.split('/')[0];
                    if (PROVIDERS[prefix]) state.providerKey = prefix;
                }
                if (s.gateways_count > 0) state.gatewaysCreated = s.gateways_count;

                // Auto-advance to first incomplete step
                if (s.has_account) {
                    currentStep = 1;
                    if (s.has_model) {
                        currentStep = 2;
                        if (s.has_profile) {
                            currentStep = 3;
                            if (s.gateways_count > 0) currentStep = 4;
                        }
                    }
                }
            }
        } catch (e) { /* start from step 0 */ }

        var nextBtn = $('ob-next');
        var backBtn = $('ob-back');
        if (nextBtn) nextBtn.addEventListener('click', goNext);
        if (backBtn) backBtn.addEventListener('click', goBack);

        render();
    }

    init();
})();
