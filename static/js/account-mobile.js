(function () {
    'use strict';

    if (window.__homunMobilePairingInit) return;
    window.__homunMobilePairingInit = true;

    let devices = [];
    let currentPairing = null;
    let pollTimer = null;
    let tunnelConfigLoaded = false;

    function byId(id) {
        return document.getElementById(id);
    }

    function showMessage(message, kind) {
        if (typeof showToast === 'function') {
            showToast(message, kind);
        } else {
            console[kind === 'error' ? 'error' : 'log'](message);
        }
    }

    function formatDate(isoString) {
        if (!isoString) return '—';
        const d = new Date(isoString);
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    async function fetchJson(url, options) {
        const res = await fetch(url, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.message || data.error || ('Request failed: ' + res.status));
        }
        return data;
    }

    function clearPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function setInlineStatus(message, kind) {
        const el = byId('mobile-pairing-inline-status');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'pairing-status' + (kind ? ' ' + kind : '');
        el.style.display = message ? '' : 'none';
    }

    function setModalStatus(message, kind) {
        const el = byId('mobile-pairing-status');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'pairing-status' + (kind ? ' ' + kind : '');
    }

    function renderDevices() {
        const list = byId('mobile-devices-list');
        const empty = byId('mobile-devices-empty');
        const badge = byId('mobile-devices-count');
        if (!list || !badge) return;

        const activeDevices = devices.filter(d => !d.revoked);
        badge.textContent = String(activeDevices.length);

        list.innerHTML = '';
        if (devices.length === 0) {
            if (empty) {
                empty.style.display = 'block';
                list.appendChild(empty);
            }
            return;
        }

        if (empty) empty.style.display = 'none';

        devices.forEach(function (device) {
            const row = document.createElement('div');
            row.className = 'item-row';

            const info = document.createElement('div');
            info.className = 'item-info';

            const name = document.createElement('div');
            name.className = 'item-name';
            name.textContent = device.name || 'Mobile device';

            const meta = document.createElement('div');
            meta.className = 'item-meta';
            meta.textContent =
                (device.platform || 'mobile') +
                ' · added ' + formatDate(device.created_at) +
                (device.last_seen_at ? ' · last seen ' + formatDate(device.last_seen_at) : '') +
                (device.can_emergency_stop ? ' · emergency stop' : '');

            info.appendChild(name);
            info.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'item-actions';

            const status = document.createElement('span');
            status.className = device.revoked ? 'badge badge-neutral' : 'badge badge-success';
            status.textContent = device.revoked ? 'Revoked' : 'Active';
            actions.appendChild(status);
            actions.appendChild(document.createTextNode(' '));

            const revokeBtn = document.createElement('button');
            revokeBtn.className = 'btn btn-ghost btn-sm';
            revokeBtn.textContent = device.revoked ? 'Removed' : 'Revoke';
            revokeBtn.disabled = !!device.revoked;
            revokeBtn.addEventListener('click', function () {
                revokeDevice(device.id);
            });
            actions.appendChild(revokeBtn);

            row.appendChild(info);
            row.appendChild(actions);
            list.appendChild(row);
        });
    }

    function updateTunnelProviderVisibility() {
        const provider = byId('mobile-tunnel-provider')?.value || 'cloudflare';
        const customFields = byId('mobile-tunnel-custom-fields');
        const ngrokFields = byId('mobile-tunnel-ngrok-fields');
        const tokenHint = byId('mobile-tunnel-token-hint');
        if (customFields) {
            customFields.style.display = provider === 'custom' ? '' : 'none';
        }
        if (ngrokFields) {
            ngrokFields.style.display = provider === 'ngrok' ? '' : 'none';
        }
        if (tokenHint) {
            if (provider === 'ngrok') {
                tokenHint.textContent = 'Leave empty if ngrok is already authenticated on this machine.';
            } else if (provider === 'cloudflare') {
                tokenHint.textContent = 'Cloudflare quick tunnel does not need a token here.';
            } else {
                tokenHint.textContent = 'Optional. Usually not needed for custom commands.';
            }
        }
    }

    function setTunnelStatus(message, kind) {
        const el = byId('mobile-tunnel-status');
        if (!el) return;
        el.textContent = message || '';
        el.className = 'form-hint pairing-status' + (kind ? ' ' + kind : '');
    }

    function renderTunnelConfig(data) {
        const tunnel = data.tunnel || {};
        const enabled = String(!!tunnel.enabled);
        if (byId('mobile-tunnel-enabled')) byId('mobile-tunnel-enabled').value = enabled;
        if (byId('mobile-tunnel-provider')) byId('mobile-tunnel-provider').value = tunnel.provider || 'cloudflare';
        if (byId('mobile-tunnel-reserved-url')) byId('mobile-tunnel-reserved-url').value = tunnel.reserved_url || '';
        if (byId('mobile-tunnel-command')) byId('mobile-tunnel-command').value = tunnel.custom_command || '';
        if (byId('mobile-tunnel-args')) byId('mobile-tunnel-args').value = (tunnel.custom_args || []).join(' ');

        updateTunnelProviderVisibility();

        const parts = [data.message || ''];
        if (data.current_public_url) {
            parts.push('Current URL: ' + data.current_public_url);
        }
        if (tunnel.has_auth_token && !byId('mobile-tunnel-auth-token')?.value) {
            parts.push('Auth token already stored.');
        }
        setTunnelStatus(
            parts.filter(Boolean).join(' '),
            data.pairing_ready ? 'success' : (tunnel.enabled ? '' : '')
        );
    }

    async function loadTunnelConfig() {
        try {
            const data = await fetchJson('/api/v1/mobile/tunnel');
            renderTunnelConfig(data);
            tunnelConfigLoaded = true;
        } catch (error) {
            tunnelConfigLoaded = false;
            setTunnelStatus(error.message, 'error');
            console.warn('[MobilePairing] Failed to load tunnel config:', error);
        }
    }

    async function saveTunnelConfig(event) {
        event.preventDefault();
        const provider = byId('mobile-tunnel-provider')?.value || 'cloudflare';
        const authToken = byId('mobile-tunnel-auth-token')?.value || '';
        const reservedUrl = byId('mobile-tunnel-reserved-url')?.value || '';
        const command = byId('mobile-tunnel-command')?.value || '';
        const argsRaw = byId('mobile-tunnel-args')?.value || '';

        try {
            const data = await fetchJson('/api/v1/mobile/tunnel', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled: (byId('mobile-tunnel-enabled')?.value || 'false') === 'true',
                    provider: provider,
                    auth_token: authToken.trim() || undefined,
                    reserved_url: reservedUrl.trim() || undefined,
                    custom_command: command.trim() || undefined,
                    custom_args: argsRaw.trim()
                        ? argsRaw.trim().split(/\s+/).filter(Boolean)
                        : []
                })
            });
            if (byId('mobile-tunnel-auth-token')) {
                byId('mobile-tunnel-auth-token').value = '';
            }
            showMessage(data.message || 'Tunnel configuration saved.');
            setTunnelStatus(data.message || 'Tunnel configuration saved.', 'success');
            await loadTunnelConfig();
        } catch (error) {
            setTunnelStatus(error.message, 'error');
            showMessage(error.message, 'error');
        }
    }

    async function loadDevices() {
        try {
            const data = await fetchJson('/api/v1/mobile/devices');
            devices = data.devices || [];
            renderDevices();
            if (devices.length) {
                setInlineStatus('Mobile app channel ready.', 'success');
            }
        } catch (error) {
            console.warn('[MobilePairing] Failed to load devices:', error);
        }
    }

    async function revokeDevice(id) {
        if (!confirm('Revoke this mobile device? It will have to pair again.')) return;
        try {
            await fetchJson('/api/v1/mobile/devices/' + encodeURIComponent(id), {
                method: 'DELETE'
            });
            showMessage('Mobile device revoked.');
            await loadDevices();
        } catch (error) {
            showMessage(error.message, 'error');
        }
    }

    function openModal() {
        const modal = byId('mobile-pairing-modal');
        if (!modal) return;
        if (modal.parentElement !== document.body) {
            document.body.appendChild(modal);
        }
        modal.classList.add('open');
    }

    function closeModal() {
        const modal = byId('mobile-pairing-modal');
        if (!modal) return;
        modal.classList.remove('open');
        clearPolling();
    }

    function updateClaimedDevice(device) {
        const container = byId('mobile-claimed-device');
        const name = byId('mobile-claimed-device-name');
        const meta = byId('mobile-claimed-device-meta');
        const approveBtn = byId('btn-mobile-approve');
        if (!container || !name || !meta || !approveBtn) return;

        if (!device) {
            container.style.display = 'none';
            approveBtn.disabled = true;
            return;
        }

        container.style.display = '';
        name.textContent = device.name || 'Mobile device';
        meta.textContent = (device.platform || 'mobile') +
            (device.app_version ? ' · ' + device.app_version : '') +
            (device.has_public_key ? ' · key attached' : '');
        approveBtn.disabled = false;
    }

    function renderPairing(pairingResponse, createResponse) {
        const qr = byId('mobile-pairing-qr');
        const meta = byId('mobile-pairing-meta');
        const refreshBtn = byId('btn-mobile-refresh-pairing');
        if (!qr || !meta || !refreshBtn) return;

        currentPairing = {
            pairingId: pairingResponse.pairing_id,
            expiresAt: pairingResponse.expires_at,
            qrPayload: createResponse.qr_payload,
        };

        qr.innerHTML = createResponse.qr_svg || '';
        meta.textContent =
            'Pairing id: ' + pairingResponse.pairing_id +
            ' · expires ' + formatDate(pairingResponse.expires_at);
        refreshBtn.disabled = false;

        if (pairingResponse.status === 'created') {
            setModalStatus('Waiting for the phone to scan the QR code.');
            updateClaimedDevice(null);
        } else if (pairingResponse.status === 'claimed') {
            setModalStatus('Device claimed. Review the phone and approve if it matches.', 'success');
            updateClaimedDevice(pairingResponse.device);
        } else if (pairingResponse.status === 'approved') {
            setModalStatus('Pairing approved. The app can complete bootstrap now.', 'success');
            updateClaimedDevice(pairingResponse.device);
        } else if (pairingResponse.status === 'expired') {
            setModalStatus('Pairing expired. Start a new session.', 'error');
            updateClaimedDevice(pairingResponse.device);
        } else {
            setModalStatus('Pairing status: ' + pairingResponse.status);
            updateClaimedDevice(pairingResponse.device);
        }
    }

    async function refreshPairingStatus() {
        if (!currentPairing) return;
        try {
            const pairing = await fetchJson('/api/v1/mobile/pairing/sessions/' + encodeURIComponent(currentPairing.pairingId));
            renderPairing(pairing, {
                qr_payload: currentPairing.qrPayload,
                qr_svg: byId('mobile-pairing-qr') ? byId('mobile-pairing-qr').innerHTML : ''
            });

            if (pairing.status === 'claimed') {
                setInlineStatus('A phone requested pairing. Review and approve it.', 'success');
            } else if (pairing.status === 'approved') {
                setInlineStatus('Mobile app approved. Waiting for app bootstrap.', 'success');
                clearPolling();
                loadDevices();
            } else if (pairing.status === 'expired') {
                setInlineStatus('Last mobile pairing expired.', 'error');
                clearPolling();
            }
        } catch (error) {
            console.warn('[MobilePairing] Failed to refresh pairing status:', error);
        }
    }

    async function createPairing() {
        const approveBtn = byId('btn-mobile-approve');
        const qr = byId('mobile-pairing-qr');
        const meta = byId('mobile-pairing-meta');
        if (approveBtn) approveBtn.disabled = true;
        if (qr) qr.innerHTML = '';
        if (meta) meta.textContent = '';
        updateClaimedDevice(null);
        setModalStatus('Creating mobile pairing session...');

        try {
            if (!tunnelConfigLoaded) {
                await loadTunnelConfig();
            }
            openModal();
            const created = await fetchJson('/api/v1/mobile/pairing/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });

            renderPairing({
                pairing_id: created.pairing_id,
                status: created.status,
                expires_at: created.expires_at,
                device: null
            }, created);

            clearPolling();
            pollTimer = setInterval(refreshPairingStatus, 2500);
            setInlineStatus('Scan the QR from the Homun mobile app.', 'success');
        } catch (error) {
            setModalStatus(error.message, 'error');
            setInlineStatus(error.message, 'error');
            showMessage(error.message, 'error');
        }
    }

    async function approvePairing() {
        if (!currentPairing) return;
        const allowEmergencyStop = !!byId('mobile-allow-estop')?.checked;
        const approveBtn = byId('btn-mobile-approve');
        if (approveBtn) {
            approveBtn.disabled = true;
            approveBtn.textContent = 'Approving...';
        }

        try {
            await fetchJson('/api/v1/mobile/pairing/sessions/' + encodeURIComponent(currentPairing.pairingId) + '/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allow_emergency_stop: allowEmergencyStop })
            });
            setModalStatus('Device approved. Finish the connection from the mobile app.', 'success');
            setInlineStatus('Mobile device approved.', 'success');
            clearPolling();
            await loadDevices();
        } catch (error) {
            setModalStatus(error.message, 'error');
            showMessage(error.message, 'error');
        } finally {
            if (approveBtn) {
                approveBtn.textContent = 'Approve Device';
                approveBtn.disabled = false;
            }
        }
    }

    function init() {
        const button = byId('btn-mobile-pairing');
        const modal = byId('mobile-pairing-modal');
        const tunnelForm = byId('mobile-tunnel-form');
        if (!button || !modal) return;
        if (button.dataset.mobilePairingBound === '1') {
            loadDevices();
            loadTunnelConfig();
            return;
        }
        button.dataset.mobilePairingBound = '1';

        button.addEventListener('click', createPairing);
        byId('btn-mobile-refresh-pairing')?.addEventListener('click', refreshPairingStatus);
        byId('btn-mobile-approve')?.addEventListener('click', approvePairing);
        byId('mobile-tunnel-provider')?.addEventListener('change', updateTunnelProviderVisibility);
        tunnelForm?.addEventListener('submit', saveTunnelConfig);

        modal.querySelectorAll('.mobile-pairing-close, .modal-backdrop').forEach(function (el) {
            el.addEventListener('click', closeModal);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modal.classList.contains('open')) {
                closeModal();
            }
        });

        loadDevices();
        loadTunnelConfig();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    document.addEventListener('settings-section-loaded', init);
})();
