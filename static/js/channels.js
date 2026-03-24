// Homun — Channels page
// Loads gateway instances from DB via /api/v1/gateways, replaces TOML-based setup.
// Each channel type card maps to a gateway row. The modal edits gateway config_json + vault token.

(function () {
    'use strict';

    function initChannels() {

    // Guard: skip init if channels DOM not present
    if (!document.querySelector('.channel-card') && !document.getElementById('channel-modal')) return;

    // ─── Constants ───────────────────────────────────────────────────

    const SUBTITLES = {
        telegram: 'Telegram Bot API \u2014 create a bot with @BotFather, paste the token, add your User ID (from @userinfobot).',
        discord: 'Discord Bot gateway \u2014 create app at discord.com/developers, enable Message Content intent.',
        slack: 'Slack Web API \u2014 create app at api.slack.com/apps, add bot scopes (chat:write, channels:history).',
        whatsapp: 'Native WhatsApp Web \u2014 enter phone number, click Start Pairing, link device in WhatsApp settings.',
        email: 'IMAP/SMTP \u2014 for Gmail enable 2FA and create an App Password.',
        web: 'Built-in browser chat interface. Always enabled.',
    };

    const TOKEN_HINTS = {
        telegram: {
            token: 'Bot token from @BotFather. Stored encrypted locally.',
            allow: 'Telegram User IDs (numeric). Get yours from @userinfobot.',
        },
        discord: {
            token: 'Bot token from Discord Developer Portal. Stored encrypted.',
            allow: 'Discord User IDs (numeric). Enable Developer Mode to copy.',
        },
        slack: {
            token: 'Bot User OAuth Token (xoxb-...) from Slack App. Stored encrypted.',
            allow: 'Slack User IDs (U...). Use "*" to allow everyone.',
        },
        whatsapp: {
            allow: 'Phone numbers of allowed senders (e.g. 393331234567).',
        },
        email: {
            allow: 'Email addresses or domains (e.g. user@example.com, @company.com). Use "*" to allow everyone.',
        },
    };

    // ─── DOM refs ────────────────────────────────────────────────────

    var channelCards = document.querySelectorAll('.channel-card');
    var chModal = document.getElementById('channel-modal');
    var chForm = document.getElementById('channel-config-form');
    var chBackdrop = chModal ? chModal.querySelector('.modal-backdrop') : null;
    var chCloseBtn = chModal ? chModal.querySelector('.ch-modal-close') : null;
    var chCancelBtn = chModal ? chModal.querySelector('.ch-modal-cancel') : null;
    var btnChSave = document.getElementById('btn-ch-save');
    var btnTestCh = document.getElementById('btn-test-channel');
    var btnWaPair = document.getElementById('btn-wa-pair');
    var chTestResult = document.getElementById('ch-test-result');
    var chSubtitle = document.getElementById('channel-subtitle');

    // Form groups
    var chTokenGroup = document.getElementById('ch-token-group');
    var chPhoneGroup = document.getElementById('ch-phone-group');
    var chAllowGroup = document.getElementById('ch-allow-from-group');
    var chDiscordGroup = document.getElementById('ch-discord-channel-group');
    var chSlackGroup = document.getElementById('ch-slack-channel-group');
    var chEmailServersGroup = document.getElementById('ch-email-servers-group');
    var chEmailCredsGroup = document.getElementById('ch-email-credentials-group');
    var chEmailBehaviorGroup = document.getElementById('ch-email-behavior-group');
    var chEmailNotifyGroup = document.getElementById('ch-email-notify-group');
    var chEmailTriggerGroup = document.getElementById('ch-email-trigger-group');
    var chWebHostGroup = document.getElementById('ch-web-host-group');
    var chWebPortGroup = document.getElementById('ch-web-port-group');
    var chWaPairing = document.getElementById('ch-wa-pairing');
    var chNotifyHint = document.getElementById('ch-notify-auto-hint');

    if (!chModal) return;

    // ─── State ───────────────────────────────────────────────────────

    var currentChannel = null;   // channel_type being edited
    var currentGateway = null;   // gateway object (null = creating new)
    var gatewaysByType = {};      // { telegram: Gateway, discord: Gateway, ... }

    // ─── Load gateways from DB ───────────────────────────────────────

    async function loadGateways() {
        try {
            var res = await fetch('/api/v1/gateways');
            if (!res.ok) return;
            var list = await res.json();
            gatewaysByType = {};
            list.forEach(function (gw) {
                // Keep first (or only) gateway per channel type for the card view
                if (!gatewaysByType[gw.channel_type]) {
                    gatewaysByType[gw.channel_type] = gw;
                }
            });
            updateCards();
        } catch (e) {
            console.error('[Channels] Failed to load gateways:', e);
        }
    }

    function updateCards() {
        channelCards.forEach(function (card) {
            var type = card.dataset.channel;
            var isWeb = card.dataset.isWeb === 'true';
            var gw = gatewaysByType[type];
            var toggle = card.querySelector('.toggle-input');
            var badge = card.querySelector('.provider-default-badge');

            if (isWeb) return; // Web is always active

            if (gw && gw.enabled) {
                card.classList.add('is-configured', 'is-active');
                card.dataset.configured = 'true';
                card.dataset.enabled = 'true';
                if (toggle) toggle.checked = true;
                if (badge) badge.style.display = 'inline-flex';
            } else if (gw) {
                card.classList.add('is-configured');
                card.classList.remove('is-active');
                card.dataset.configured = 'true';
                card.dataset.enabled = 'false';
                if (toggle) toggle.checked = false;
                if (badge) badge.style.display = 'none';
            } else {
                card.classList.remove('is-configured', 'is-active');
                card.dataset.configured = 'false';
                card.dataset.enabled = 'false';
                if (toggle) toggle.checked = false;
                if (badge) badge.style.display = 'none';
            }
        });
    }

    // ─── Email mode toggle ───────────────────────────────────────────

    function updateEmailModeFields() {
        var modeEl = document.getElementById('ch-email-mode');
        var modeHint = document.getElementById('ch-email-mode-hint');
        if (!modeEl) return;
        var mode = modeEl.value;
        if (chEmailNotifyGroup) chEmailNotifyGroup.style.display = (mode === 'assisted' || mode === 'automatic') ? 'block' : 'none';
        if (chEmailTriggerGroup) chEmailTriggerGroup.style.display = mode === 'on_demand' ? 'block' : 'none';
        if (modeHint) {
            if (mode === 'assisted') modeHint.textContent = 'Generates summary and draft, sends to notification channel for approval.';
            else if (mode === 'automatic') modeHint.textContent = 'Responds directly to emails. Escalates to notification channel if unsure.';
            else if (mode === 'on_demand') modeHint.textContent = 'Only processes emails containing the trigger word. Others are ignored.';
        }
    }

    var emailModeSelect = document.getElementById('ch-email-mode');
    if (emailModeSelect) emailModeSelect.addEventListener('change', updateEmailModeFields);

    // Chat channel behavior: show/hide notify fields based on response mode
    var chResponseMode = document.getElementById('ch-response-mode');
    if (chResponseMode) {
        chResponseMode.addEventListener('change', function () {
            var mode = chResponseMode.value;
            var showNotify = mode === 'assisted';
            var notifyCh = document.getElementById('ch-notify-channel-group');
            var notifyCid = document.getElementById('ch-notify-chatid-group');
            if (notifyCh) notifyCh.style.display = showNotify ? 'block' : 'none';
            if (notifyCid) notifyCid.style.display = showNotify ? 'block' : 'none';
        });
    }

    // ─── Card click handlers ─────────────────────────────────────────

    channelCards.forEach(function (card) {
        var toggle = card.querySelector('.toggle-input');
        var toggleLabel = card.querySelector('.toggle-label');
        var isWeb = card.dataset.isWeb === 'true';

        card.style.cursor = 'pointer';
        card.addEventListener('click', function (e) {
            if (e.target === toggle || e.target === toggleLabel) return;
            openChannelModal(card);
        });

        if (toggle && !isWeb) {
            toggle.addEventListener('change', function () {
                var type = card.dataset.channel;
                var gw = gatewaysByType[type];
                if (toggle.checked) {
                    if (!gw) {
                        toggle.checked = false;
                        openChannelModal(card);
                    } else {
                        // Enable existing gateway
                        toggleGateway(gw.id, true, card);
                    }
                } else {
                    var displayName = card.dataset.display;
                    if (confirm('Deactivate ' + displayName + '?')) {
                        toggleGateway(gw.id, false, card);
                    } else {
                        toggle.checked = true;
                    }
                }
            });
        }
    });

    async function toggleGateway(id, enabled, card) {
        try {
            var resp = await fetch('/api/v1/gateways/' + id, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enabled }),
            });
            if (resp.ok) {
                await loadGateways();
            } else {
                // Revert toggle
                var toggle = card.querySelector('.toggle-input');
                if (toggle) toggle.checked = !enabled;
            }
        } catch (e) {
            var toggle = card.querySelector('.toggle-input');
            if (toggle) toggle.checked = !enabled;
        }
    }

    // ─── Open channel modal ──────────────────────────────────────────

    function openChannelModal(card) {
        currentChannel = card.dataset.channel;
        currentGateway = gatewaysByType[currentChannel] || null;

        var display = card.dataset.display;
        var isWeb = card.dataset.isWeb === 'true';
        var hasToken = ['telegram', 'discord', 'slack'].indexOf(currentChannel) >= 0;

        document.getElementById('modal-channel-name').textContent = display;
        document.getElementById('modal-channel-id').value = currentChannel;

        // Subtitle
        if (chSubtitle) chSubtitle.textContent = SUBTITLES[currentChannel] || '';

        // Show/hide form groups based on channel type
        var isEmail = currentChannel === 'email';
        if (chTokenGroup) chTokenGroup.style.display = hasToken ? 'block' : 'none';
        if (chPhoneGroup) chPhoneGroup.style.display = currentChannel === 'whatsapp' ? 'block' : 'none';
        if (chAllowGroup) chAllowGroup.style.display = (currentChannel !== 'web' && !isEmail) ? 'block' : 'none';
        if (chDiscordGroup) chDiscordGroup.style.display = currentChannel === 'discord' ? 'block' : 'none';
        if (chSlackGroup) chSlackGroup.style.display = currentChannel === 'slack' ? 'block' : 'none';
        if (chEmailServersGroup) chEmailServersGroup.style.display = isEmail ? 'block' : 'none';
        if (chEmailCredsGroup) chEmailCredsGroup.style.display = isEmail ? 'block' : 'none';
        if (chEmailBehaviorGroup) chEmailBehaviorGroup.style.display = isEmail ? 'block' : 'none';
        if (chWebHostGroup) chWebHostGroup.style.display = isWeb ? 'block' : 'none';
        if (chWebPortGroup) chWebPortGroup.style.display = isWeb ? 'block' : 'none';
        if (chWaPairing) chWaPairing.style.display = 'none';
        var isChatChannel = ['telegram', 'whatsapp', 'discord', 'slack'].indexOf(currentChannel) >= 0;
        var chBehaviorGroup = document.getElementById('ch-behavior-group');
        if (chBehaviorGroup) chBehaviorGroup.style.display = isChatChannel ? 'block' : 'none';
        if (chEmailNotifyGroup) chEmailNotifyGroup.style.display = 'none';
        if (chEmailTriggerGroup) chEmailTriggerGroup.style.display = 'none';
        if (btnWaPair) btnWaPair.style.display = currentChannel === 'whatsapp' ? 'inline-flex' : 'none';
        if (btnTestCh) btnTestCh.style.display = isWeb ? 'none' : 'inline-flex';
        if (btnChSave) btnChSave.style.display = 'inline-flex';
        if (chNotifyHint) chNotifyHint.textContent = '';

        // Set hints
        var hints = TOKEN_HINTS[currentChannel];
        if (hints) {
            var tokenHint = document.getElementById('ch-token-hint');
            if (tokenHint && hints.token) tokenHint.textContent = hints.token;
            var allowHint = document.getElementById('ch-allow-from-hint');
            if (allowHint && hints.allow) allowHint.textContent = hints.allow;
        }

        // Clear fields
        document.getElementById('ch-token').value = '';
        document.getElementById('ch-token').placeholder = 'Paste token here...';
        document.getElementById('ch-phone').value = '';
        document.getElementById('ch-allow-from').value = '';
        document.getElementById('ch-discord-channel').value = '';
        document.getElementById('ch-slack-channel').value = '';
        document.getElementById('ch-web-host').value = '';
        document.getElementById('ch-web-port').value = '';
        clearEmailFields();

        // Reset test result
        if (chTestResult) {
            chTestResult.textContent = '';
            chTestResult.className = 'form-hint';
        }

        // Load profile select + gateway data
        loadModalData();

        // Move modal to body so it escapes the settings modal stacking context
        if (chModal.parentElement !== document.body) {
            document.body.appendChild(chModal);
        }
        chModal.classList.add('open');
        document.body.style.overflow = 'hidden';
    }

    function clearEmailFields() {
        var fields = ['ch-email-imap-host', 'ch-email-imap-port', 'ch-email-smtp-host', 'ch-email-smtp-port',
            'ch-email-username', 'ch-email-from'];
        fields.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var pw = document.getElementById('ch-email-password');
        if (pw) { pw.value = ''; pw.placeholder = 'App password (stored encrypted)'; }
    }

    async function loadModalData() {
        // Fetch profiles + gateway details in parallel
        var profilesP = fetch('/api/v1/profiles').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
        var gwP = currentGateway
            ? fetch('/api/v1/gateways/' + currentGateway.id).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            : Promise.resolve(null);

        var results = await Promise.all([profilesP, gwP]);
        var profiles = results[0];
        var gw = results[1];

        // Populate profile select
        var personaEl = document.getElementById('ch-persona');
        if (personaEl) {
            while (personaEl.firstChild) personaEl.removeChild(personaEl.firstChild);
            profiles.forEach(function (p) {
                var opt = document.createElement('option');
                opt.value = p.slug;
                opt.textContent = p.display_name + (p.is_default ? ' (default)' : '');
                personaEl.appendChild(opt);
            });
        }

        if (!gw) return; // New gateway — fields stay empty

        // Parse config_json to fill form fields
        var cfg = {};
        try { cfg = JSON.parse(gw.config_json || '{}'); } catch (e) { /* empty */ }

        // Token placeholder (config_json may have masked token)
        if (cfg.token && cfg.token !== '***ENCRYPTED***') {
            document.getElementById('ch-token').placeholder = cfg.token; // masked by API
        } else if (cfg.token === '***ENCRYPTED***') {
            document.getElementById('ch-token').placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (stored encrypted)';
        }

        // Allow-from
        if (cfg.allow_from && cfg.allow_from.length > 0) {
            document.getElementById('ch-allow-from').value = cfg.allow_from.join(', ');
        }

        // WhatsApp phone
        if (cfg.phone_number) {
            document.getElementById('ch-phone').value = cfg.phone_number;
        }

        // Discord default channel
        if (cfg.default_channel_id) {
            document.getElementById('ch-discord-channel').value = cfg.default_channel_id;
        }

        // Slack channel
        if (cfg.channel_id) {
            document.getElementById('ch-slack-channel').value = cfg.channel_id;
        }

        // Web host/port
        if (cfg.host) document.getElementById('ch-web-host').value = cfg.host;
        if (cfg.port) document.getElementById('ch-web-port').value = cfg.port;

        // Email fields
        if (cfg.imap_host) setVal('ch-email-imap-host', cfg.imap_host);
        if (cfg.imap_port) setVal('ch-email-imap-port', cfg.imap_port);
        if (cfg.smtp_host) setVal('ch-email-smtp-host', cfg.smtp_host);
        if (cfg.smtp_port) setVal('ch-email-smtp-port', cfg.smtp_port);
        if (cfg.username) setVal('ch-email-username', cfg.username);
        if (cfg.from_address) setVal('ch-email-from', cfg.from_address);
        if (cfg.password && cfg.password !== '***ENCRYPTED***') {
            var pw = document.getElementById('ch-email-password');
            if (pw) pw.placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (stored encrypted)';
        }

        // Email mode/notify/trigger
        if (currentChannel === 'email') {
            setVal('ch-email-mode', cfg.mode || gw.response_mode || 'assisted');
            setVal('ch-email-notify-channel', cfg.notify_channel || '');
            setVal('ch-email-notify-chat-id', cfg.notify_chat_id || '');
            setVal('ch-email-trigger-word', cfg.trigger_word || '');
            updateEmailModeFields();
        }

        // Profile
        if (personaEl) {
            personaEl.value = gw.default_profile || cfg.persona || 'default';
        }

        // Response mode (chat channels)
        var rmEl = document.getElementById('ch-response-mode');
        if (rmEl) {
            rmEl.value = gw.response_mode || cfg.response_mode || '';
        }
    }

    function setVal(id, val) {
        var el = document.getElementById(id);
        if (el && val !== undefined && val !== null) el.value = val;
    }

    // ─── Close modal ─────────────────────────────────────────────────

    function closeChannelModal() {
        chModal.classList.remove('open');
        document.body.style.overflow = '';
        currentChannel = null;
        currentGateway = null;
    }

    [chBackdrop, chCloseBtn, chCancelBtn].forEach(function (el) {
        if (el) el.addEventListener('click', closeChannelModal);
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && chModal.classList.contains('open')) closeChannelModal();
    });

    // ─── Save channel config ─────────────────────────────────────────

    if (chForm) {
        chForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            var btn = btnChSave;
            var originalText = btn.textContent;
            btn.textContent = 'Saving\u2026';
            btn.disabled = true;

            // Build config_json from form fields
            var configObj = buildConfigJson();

            // Build gateway payload
            var payload = {};
            var token = document.getElementById('ch-token').value.trim();
            if (token) payload.token = token;

            var personaEl = document.getElementById('ch-persona');
            if (personaEl && personaEl.value) payload.default_profile = personaEl.value;

            // Response mode — from chat behavior or email mode
            var rmEl = document.getElementById('ch-response-mode');
            if (rmEl && rmEl.value) {
                payload.response_mode = rmEl.value;
            } else if (currentChannel === 'email') {
                var modeEl = document.getElementById('ch-email-mode');
                if (modeEl) payload.response_mode = modeEl.value;
            }

            payload.config_json = JSON.stringify(configObj);

            // Email password goes to vault via a separate token field
            if (currentChannel === 'email') {
                var pw = document.getElementById('ch-email-password').value;
                if (pw) payload.token = pw; // stored as gateway.{id}.token
            }

            // Slack app_token
            if (currentChannel === 'slack') {
                var appTokenEl = document.getElementById('ch-slack-app-token');
                if (appTokenEl && appTokenEl.value.trim()) {
                    payload.app_token = appTokenEl.value.trim();
                }
            }

            try {
                var url, method;
                if (currentGateway) {
                    url = '/api/v1/gateways/' + currentGateway.id;
                    method = 'PUT';
                    payload.enabled = true; // saving = enabling
                } else {
                    url = '/api/v1/gateways';
                    method = 'POST';
                    payload.name = currentChannel.charAt(0).toUpperCase() + currentChannel.slice(1);
                    payload.channel_type = currentChannel;
                }

                var resp = await fetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (resp.ok) {
                    btn.textContent = 'Saved \u2713';
                    await loadGateways();
                    setTimeout(function () {
                        closeChannelModal();
                        btn.textContent = originalText;
                        btn.disabled = false;
                    }, 800);
                } else {
                    var err = await resp.json().catch(function () { return {}; });
                    btn.textContent = 'Error';
                    alert(err.error || 'Failed to save');
                    setTimeout(function () {
                        btn.textContent = originalText;
                        btn.disabled = false;
                    }, 1500);
                }
            } catch (err) {
                btn.textContent = 'Error';
                setTimeout(function () {
                    btn.textContent = originalText;
                    btn.disabled = false;
                }, 1500);
            }
        });
    }

    /// Build config_json object from form fields (channel-specific).
    function buildConfigJson() {
        var cfg = {};

        // Token marker — actual token goes to vault, config_json gets marker
        if (currentChannel === 'telegram' || currentChannel === 'discord' || currentChannel === 'slack') {
            cfg.token = '***ENCRYPTED***';
        }

        // Allow-from
        var allowEl = document.getElementById('ch-allow-from');
        if (allowEl && allowEl.value.trim()) {
            cfg.allow_from = allowEl.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else {
            cfg.allow_from = [];
        }

        // Channel-specific fields
        if (currentChannel === 'telegram') {
            cfg.enabled = true;
        } else if (currentChannel === 'whatsapp') {
            cfg.enabled = true;
            cfg.phone_number = document.getElementById('ch-phone').value.trim();
        } else if (currentChannel === 'discord') {
            cfg.enabled = true;
            cfg.default_channel_id = document.getElementById('ch-discord-channel').value.trim();
        } else if (currentChannel === 'slack') {
            cfg.enabled = true;
            cfg.channel_id = document.getElementById('ch-slack-channel').value.trim();
            cfg.app_token = '***ENCRYPTED***';
        } else if (currentChannel === 'email') {
            cfg.enabled = true;
            cfg.imap_host = getVal('ch-email-imap-host');
            cfg.imap_port = parseInt(getVal('ch-email-imap-port') || '993', 10);
            cfg.smtp_host = getVal('ch-email-smtp-host');
            cfg.smtp_port = parseInt(getVal('ch-email-smtp-port') || '465', 10);
            cfg.username = getVal('ch-email-username');
            cfg.from_address = getVal('ch-email-from');
            cfg.password = '***ENCRYPTED***';
            // Email behavior
            cfg.mode = getVal('ch-email-mode') || 'assisted';
            cfg.notify_channel = getVal('ch-email-notify-channel');
            cfg.notify_chat_id = getVal('ch-email-notify-chat-id');
            cfg.trigger_word = getVal('ch-email-trigger-word');
        } else if (currentChannel === 'web') {
            cfg.enabled = true;
            cfg.host = getVal('ch-web-host');
            var port = getVal('ch-web-port');
            if (port) cfg.port = parseInt(port, 10);
        }

        // Response mode / notify (chat channels)
        var rmEl = document.getElementById('ch-response-mode');
        if (rmEl && rmEl.value) cfg.response_mode = rmEl.value;
        var ncEl = document.getElementById('ch-notify-channel');
        if (ncEl && ncEl.value) cfg.notify_channel = ncEl.value;
        var ncidEl = document.getElementById('ch-notify-chatid');
        if (ncidEl && ncidEl.value) cfg.notify_chat_id = ncidEl.value;

        return cfg;
    }

    function getVal(id) {
        var el = document.getElementById(id);
        return el ? el.value.trim() : '';
    }

    // ─── Test channel connection ─────────────────────────────────────

    if (btnTestCh) {
        btnTestCh.addEventListener('click', async function () {
            btnTestCh.textContent = 'Testing\u2026';
            btnTestCh.disabled = true;

            var payload = { name: currentChannel };
            var tokenVal = document.getElementById('ch-token').value.trim();
            if (tokenVal) payload.token = tokenVal;

            // If editing existing gateway, pass gateway_id so test can read vault
            if (currentGateway) payload.gateway_id = currentGateway.id;

            try {
                var resp = await fetch('/api/v1/channels/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                var data = await resp.json();
                chTestResult.textContent = (data.ok ? '\u2713 ' : '\u2717 ') + data.message;
                chTestResult.className = 'form-hint ' + (data.ok ? 'pairing-status success' : 'pairing-status error');
            } catch (err) {
                chTestResult.textContent = '\u2717 Connection failed';
                chTestResult.className = 'form-hint pairing-status error';
            }

            btnTestCh.textContent = 'Test Connection';
            btnTestCh.disabled = false;
        });
    }

    // ─── WhatsApp Pairing (WebSocket) ────────────────────────────────

    if (btnWaPair) {
        var pairingWs = null;

        btnWaPair.addEventListener('click', function () {
            var phone = document.getElementById('ch-phone').value.trim();
            if (!phone) {
                alert('Enter a phone number first.');
                return;
            }

            if (pairingWs) {
                pairingWs.close();
                pairingWs = null;
            }

            var statusEl = document.getElementById('ch-wa-pairing-status');
            var codeEl = document.getElementById('ch-wa-pairing-code');

            chWaPairing.style.display = 'block';
            statusEl.textContent = 'Connecting\u2026';
            statusEl.className = 'pairing-status';
            codeEl.style.display = 'none';
            btnWaPair.disabled = true;
            btnWaPair.textContent = 'Pairing\u2026';

            var proto = location.protocol === 'https:' ? 'wss' : 'ws';
            var wsUrl = proto + '://' + location.host + '/api/v1/channels/whatsapp/pair?phone=' + encodeURIComponent(phone);
            pairingWs = new WebSocket(wsUrl);

            pairingWs.onmessage = function (ev) {
                try {
                    var msg = JSON.parse(ev.data);
                    if (msg.code) {
                        codeEl.textContent = msg.code;
                        codeEl.style.display = 'block';
                        statusEl.textContent = 'Enter this code in WhatsApp \u2192 Linked Devices \u2192 Link a Device';
                        statusEl.className = 'pairing-status';
                    }
                    if (msg.status === 'connected') {
                        statusEl.textContent = '\u2713 Connected!';
                        statusEl.className = 'pairing-status success';
                        codeEl.style.display = 'none';
                        btnWaPair.textContent = 'Start Pairing';
                        btnWaPair.disabled = false;
                        pairingWs.close();
                        pairingWs = null;
                    }
                    if (msg.error) {
                        statusEl.textContent = '\u2717 ' + msg.error;
                        statusEl.className = 'pairing-status error';
                        btnWaPair.textContent = 'Retry Pairing';
                        btnWaPair.disabled = false;
                    }
                } catch (e) { /* ignore non-JSON */ }
            };

            pairingWs.onerror = function () {
                statusEl.textContent = '\u2717 WebSocket error';
                statusEl.className = 'pairing-status error';
                btnWaPair.textContent = 'Retry Pairing';
                btnWaPair.disabled = false;
            };

            pairingWs.onclose = function () {
                if (btnWaPair.textContent === 'Pairing\u2026') {
                    btnWaPair.textContent = 'Start Pairing';
                    btnWaPair.disabled = false;
                }
            };
        });
    }

    // ─── Auto-populate Notify Chat ID ────────────────────────────────

    var notifyChannelSelect = document.getElementById('ch-email-notify-channel');
    var notifyChatIdInput = document.getElementById('ch-email-notify-chat-id');
    if (notifyChannelSelect) {
        notifyChannelSelect.addEventListener('change', function () {
            var ch = notifyChannelSelect.value;
            if (chNotifyHint) chNotifyHint.textContent = '';
            if (!ch) return;
            // Look up the gateway for that channel type to suggest a chat ID
            var gw = gatewaysByType[ch];
            if (!gw) return;
            try {
                var cfg = JSON.parse(gw.config_json || '{}');
                var id = '';
                if (ch === 'discord') id = cfg.default_channel_id || (cfg.allow_from || [])[0] || '';
                else if (ch === 'slack') id = cfg.channel_id || (cfg.allow_from || [])[0] || '';
                else id = (cfg.allow_from || [])[0] || '';
                if (id && notifyChatIdInput && !notifyChatIdInput.value.trim()) {
                    notifyChatIdInput.value = id;
                }
                if (id && chNotifyHint) chNotifyHint.textContent = 'Suggested: ' + id;
            } catch (e) { /* ignore */ }
        });
    }

    // ─── Init ────────────────────────────────────────────────────────

    loadGateways();

    } // end initChannels

    initChannels();
    document.addEventListener('settings-section-loaded', initChannels);
})();
