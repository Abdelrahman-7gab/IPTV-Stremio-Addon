(function () {
    const installCodeInput = document.getElementById('installCode');
    const sourceInfoEl = document.getElementById('sourceInfo');
    const installStatusEl = document.getElementById('installStatus');

    const authEmailInput = document.getElementById('authEmail');
    const authPasswordInput = document.getElementById('authPassword');
    const loginBtn = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const authStatusEl = document.getElementById('authStatus');

    const installBtn = document.getElementById('installSnapshotBtn');
    const downloadSyncBtn = document.getElementById('downloadSyncBtn');

    const snapshotTitleEl = document.getElementById('snapshotTitleValue');
    const lastSyncedEl = document.getElementById('lastSyncedValue');
    const nextAllowedEl = document.getElementById('nextAllowedValue');
    const refreshStatusEl = document.getElementById('refreshStatusValue');

    const {
        appendDetail,
        buildUrls,
        forceDisableActions,
        getTokenConfigFromLocation,
        hideOverlay,
        overlaySetMessage,
        setProgress,
        showOverlay,
        startPolling
    } = window.ConfigureCommon || {};

    if (!window.ConfigureCommon || !window.supabase) {
        console.error('[XTREAM-SNAPSHOT] Missing dependencies');
        return;
    }

    const state = {
        authUser: null,
        snapshot: null,
        supabaseClient: null,
        snapshotSource: null
    };

    function setPill(el, message, good) {
        if (!el) return;
        el.textContent = message;
        el.className = good ? 'status-pill ok' : 'status-pill warn';
    }

    function setAuthStatus(message, good) {
        setPill(authStatusEl, message, good);
    }

    function setInstallStatus(message, good) {
        setPill(installStatusEl, message, good);
    }

    function updateSnapshotStatus(snapshot) {
        state.snapshot = snapshot || null;
        snapshotTitleEl.textContent = snapshot?.title || 'Main IPTV Snapshot';
        lastSyncedEl.textContent = snapshot?.lastRefreshedAt || 'Never';
        nextAllowedEl.textContent = snapshot?.nextAllowedSyncAt || 'Now';
        refreshStatusEl.textContent = !snapshot
            ? 'Unavailable'
            : snapshot.canRefresh === false
                ? 'Cooldown active'
                : (snapshot.lastRefreshedAt ? 'Ready' : 'Not synced yet');
        downloadSyncBtn.disabled = !state.authUser;
    }

    async function fetchPublicConfig() {
        const response = await fetch('/api/public-config');
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.supabase?.url || !payload?.supabase?.publishableKey) {
            throw new Error(payload.message || 'Failed to load Supabase browser config');
        }
        return payload;
    }

    async function fetchSnapshotStatus() {
        const response = await fetch('/api/snapshot');
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(payload.message || 'Failed to load snapshot status');
        }
        updateSnapshotStatus(payload);
        return payload;
    }

    async function getAccessToken() {
        const { data } = await state.supabaseClient.auth.getSession();
        return data.session?.access_token || '';
    }

    async function sessionCheck() {
        const token = await getAccessToken();
        if (!token) {
            state.authUser = null;
            setAuthStatus('Not signed in.', false);
            updateSnapshotStatus(state.snapshot);
            return null;
        }

        const response = await fetch('/api/auth/session-check', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
            state.authUser = null;
            setAuthStatus(payload.message || 'Sign-in is valid but not allowlisted.', false);
            updateSnapshotStatus(state.snapshot);
            return null;
        }

        state.authUser = payload.user;
        setAuthStatus(`Signed in as ${payload.user.email}`, true);
        updateSnapshotStatus(state.snapshot);
        return {
            token,
            user: payload.user
        };
    }

    async function login() {
        const email = authEmailInput.value.trim();
        const password = authPasswordInput.value;
        if (!email || !password) {
            setAuthStatus('Email and password are required.', false);
            return;
        }

        const { error } = await state.supabaseClient.auth.signInWithPassword({ email, password });
        if (error) {
            setAuthStatus(error.message || 'Login failed.', false);
            return;
        }

        authPasswordInput.value = '';
        await sessionCheck();
        await refreshAdminSnapshotStatus();
    }

    async function logout() {
        await state.supabaseClient.auth.signOut();
        state.authUser = null;
        setAuthStatus('Signed out.', false);
        updateSnapshotStatus(state.snapshot);
    }

    async function refreshAdminSnapshotStatus() {
        await fetchSnapshotStatus();
        const auth = await sessionCheck();
        if (!auth) return state.snapshot;

        const response = await fetch('/api/snapshot/refresh-authorize', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${auth.token}`
            }
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) {
            updateSnapshotStatus({
                ...(state.snapshot || {}),
                lastRefreshedAt: payload.lastRefreshedAt,
                nextAllowedSyncAt: payload.nextAllowedSyncAt,
                canRefresh: !!payload.canRefresh
            });
            return state.snapshot;
        }

        if (payload.error === 'snapshot_cooldown') {
            updateSnapshotStatus({
                ...(state.snapshot || {}),
                lastRefreshedAt: payload.lastRefreshedAt || state.snapshot?.lastRefreshedAt || null,
                nextAllowedSyncAt: payload.nextAllowedSyncAt || state.snapshot?.nextAllowedSyncAt || null,
                canRefresh: false
            });
            return state.snapshot;
        }

        throw new Error(payload.message || 'Failed to verify snapshot sync status');
    }

    function buildSnapshotToken(accessCode) {
        return {
            provider: 'xtream_snapshot',
            accessCode,
            instanceId: (crypto && crypto.randomUUID) ? crypto.randomUUID() : `snap-${Date.now().toString(36)}`,
            enableEpg: false
        };
    }

    async function downloadSyncFile() {
        try {
            const auth = await sessionCheck();
            if (!auth) throw new Error('Sign in with an allowlisted Supabase user first');

            const response = await fetch('/api/snapshot/download-sync-file', {
                headers: {
                    Authorization: `Bearer ${auth.token}`
                }
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload.message || 'Failed to download sync file');
            }

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'iptv-sync.html';
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            alert(error.message || 'Failed to download sync file');
        }
    }

    async function installSnapshot() {
        const accessCode = installCodeInput.value.trim();
        if (!accessCode) {
            setInstallStatus('Enter the secret code first.', false);
            installCodeInput.focus();
            return;
        }

        try {
            const authorizeResponse = await fetch('/api/install/authorize', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ code: accessCode })
            });
            const authorizePayload = await authorizeResponse.json().catch(() => ({}));
            if (!authorizeResponse.ok) {
                throw new Error(authorizePayload.message || 'The secret code is invalid');
            }

            updateSnapshotStatus(authorizePayload.snapshot);
            setInstallStatus('Secret accepted. Building install link…', true);

            const config = buildSnapshotToken(accessCode);
            showOverlay(true);
            forceDisableActions && forceDisableActions();
            overlaySetMessage('Building addon token…');
            setProgress(20, 'Creating token');
            appendDetail('== MANAGED SNAPSHOT MODE ==');
            appendDetail(`Snapshot: ${authorizePayload.snapshot?.title || 'Main IPTV Snapshot'}`);
            appendDetail(`Last synced: ${authorizePayload.snapshot?.lastRefreshedAt || 'never'}`);
            appendDetail(`Next allowed admin sync: ${authorizePayload.snapshot?.nextAllowedSyncAt || 'now'}`);

            const { manifestUrl, stremioUrl } = buildUrls(config);
            appendDetail('Manifest URL: ' + manifestUrl);
            appendDetail('Stremio URL: ' + stremioUrl);
            appendDetail('Polling hosted manifest…');
            setProgress(55, 'Waiting for manifest');
            startPolling(55);
        } catch (error) {
            console.error('[XTREAM-SNAPSHOT]', error);
            setInstallStatus(error.message || 'Install failed', false);
            overlaySetMessage('Install failed');
            setProgress(100, 'Failed');
            appendDetail('✖ ' + (error.message || error.toString()));
            const status = document.getElementById('statusDetails');
            if (status && !document.getElementById('retryCloseXtreamBtn')) {
                const btn = document.createElement('button');
                btn.id = 'retryCloseXtreamBtn';
                btn.textContent = 'Close';
                btn.className = 'btn danger';
                btn.style.marginTop = '14px';
                btn.onclick = hideOverlay;
                status.parentElement.appendChild(btn);
            }
        }
    }

    function initializeFromLocation() {
        const tokenConfig = typeof getTokenConfigFromLocation === 'function' ? getTokenConfigFromLocation() : null;
        if (!tokenConfig || tokenConfig.provider !== 'xtream_snapshot') return;

        if (tokenConfig.accessCode) {
            installCodeInput.value = tokenConfig.accessCode;
            setInstallStatus('Existing snapshot install token loaded.', true);
        }
    }

    async function boot() {
        try {
            const publicConfig = await fetchPublicConfig();
            state.snapshotSource = publicConfig.snapshotSource || null;
            state.supabaseClient = window.supabase.createClient(publicConfig.supabase.url, publicConfig.supabase.publishableKey);
            if (sourceInfoEl) {
                sourceInfoEl.textContent = state.snapshotSource?.xtreamUrl || state.snapshotSource?.label || 'Managed Xtream source';
            }
            initializeFromLocation();
            await fetchSnapshotStatus();
            await sessionCheck();
        } catch (error) {
            console.error('[XTREAM-SNAPSHOT] boot failed', error);
            setAuthStatus(error.message || 'Failed to initialize snapshot mode', false);
            setInstallStatus(error.message || 'Failed to initialize install mode', false);
        }
    }

    installCodeInput.addEventListener('input', () => {
        setInstallStatus('Enter the secret code to install.', false);
    });
    loginBtn.addEventListener('click', login);
    logoutBtn.addEventListener('click', logout);
    downloadSyncBtn.addEventListener('click', downloadSyncFile);
    installBtn.addEventListener('click', installSnapshot);

    boot();
})();
