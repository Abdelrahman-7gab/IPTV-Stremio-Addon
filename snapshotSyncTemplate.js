const fs = require('fs');
const path = require('path');
const { SNAPSHOT_REFRESH_COOLDOWN_MINUTES } = require('./snapshotStore');

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function serializeInlineJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function readNormalizerSource() {
    return fs.readFileSync(path.join(__dirname, 'snapshotNormalizer.js'), 'utf8');
}

function renderSnapshotSyncFile({ snapshot, publicConfig, appOrigin, defaultEmail = '' }) {
    const embedded = {
        snapshotTitle: snapshot.title,
        snapshotId: snapshot.id,
        sourceConfig: snapshot.sourceConfig,
        supabase: publicConfig,
        endpoints: {
            sessionCheck: `${appOrigin}/api/auth/session-check`,
            readSnapshot: `${appOrigin}/api/snapshots/${snapshot.id}`,
            authorizeRefresh: `${appOrigin}/api/snapshot/refresh-authorize`,
            upload: `${appOrigin}/api/snapshot/upload`
        }
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${escapeHtml(snapshot.title)} Sync</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
        :root {
            color-scheme: light;
            --bg: #f5f3eb;
            --card: rgba(255, 252, 245, 0.92);
            --ink: #1c1d1f;
            --muted: #5e625f;
            --accent: #0e6b5c;
            --accent-2: #d16b3d;
            --border: rgba(28, 29, 31, 0.12);
            --danger: #b63f2a;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Avenir Next", "Segoe UI", sans-serif;
            background:
                radial-gradient(circle at top left, rgba(209,107,61,0.16), transparent 38%),
                radial-gradient(circle at top right, rgba(14,107,92,0.16), transparent 42%),
                var(--bg);
            color: var(--ink);
        }
        .wrap {
            max-width: 920px;
            margin: 0 auto;
            padding: 32px 20px 64px;
        }
        .hero {
            padding: 28px;
            border-radius: 28px;
            background: linear-gradient(145deg, rgba(255,255,255,0.9), rgba(255,247,233,0.86));
            border: 1px solid var(--border);
            box-shadow: 0 18px 44px rgba(0,0,0,0.08);
        }
        h1 {
            margin: 0 0 8px;
            font-size: clamp(2rem, 4vw, 3rem);
            line-height: 1;
        }
        .sub {
            margin: 0;
            color: var(--muted);
            max-width: 58ch;
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 18px;
            margin-top: 22px;
        }
        .card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 22px;
            padding: 18px;
            backdrop-filter: blur(10px);
        }
        .card h2 {
            margin: 0 0 12px;
            font-size: 1rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }
        label {
            display: block;
            font-size: 0.9rem;
            margin-bottom: 12px;
        }
        input {
            width: 100%;
            margin-top: 6px;
            padding: 12px 13px;
            border-radius: 14px;
            border: 1px solid var(--border);
            font: inherit;
            background: rgba(255,255,255,0.9);
        }
        button {
            border: 0;
            border-radius: 999px;
            padding: 12px 16px;
            font: inherit;
            cursor: pointer;
        }
        .primary { background: var(--accent); color: #fff; }
        .secondary { background: rgba(28,29,31,0.08); color: var(--ink); }
        .danger { background: var(--danger); color: #fff; }
        .button-row {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 10px;
        }
        .status-line {
            margin: 0 0 8px;
            color: var(--muted);
        }
        .status-good { color: var(--accent); }
        .status-bad { color: var(--danger); }
        .log {
            min-height: 280px;
            margin-top: 22px;
            padding: 18px;
            border-radius: 22px;
            background: #111714;
            color: #d7ece4;
            border: 1px solid rgba(255,255,255,0.06);
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            font-family: "SFMono-Regular", Consolas, monospace;
            font-size: 0.9rem;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
        }
        .pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 7px 11px;
            border-radius: 999px;
            background: rgba(14,107,92,0.08);
            color: var(--accent);
            font-size: 0.85rem;
            font-weight: 600;
        }
        @media (max-width: 640px) {
            .wrap { padding: 20px 14px 40px; }
            .hero { padding: 22px; border-radius: 22px; }
        }
    </style>
</head>
<body>
    <div class="wrap">
        <section class="hero">
            <div class="pill">Local sync only • ${SNAPSHOT_REFRESH_COOLDOWN_MINUTES}-minute cooldown</div>
            <h1>${escapeHtml(snapshot.title)}</h1>
            <p class="sub">This file runs the Xtream fetch from your machine, normalizes the snapshot, and uploads a full overwrite to the hosted addon backend. The hosted addon never calls the Xtream panel directly in snapshot mode.</p>
        </section>

        <div class="grid">
            <section class="card">
                <h2>Supabase Sign-In</h2>
                <p id="authStatus" class="status-line">Not signed in.</p>
                <label>
                    Email
                    <input id="emailInput" type="email" autocomplete="username" value="${escapeHtml(defaultEmail)}">
                </label>
                <label>
                    Password
                    <input id="passwordInput" type="password" autocomplete="current-password">
                </label>
                <div class="button-row">
                    <button id="loginBtn" class="primary" type="button">Login</button>
                    <button id="logoutBtn" class="secondary" type="button">Logout</button>
                </div>
            </section>

            <section class="card">
                <h2>Snapshot Status</h2>
                <p id="snapshotStatus" class="status-line">Checking refresh permission…</p>
                <p id="snapshotMeta" class="status-line"></p>
                <label>
                    <input id="forceSeriesRefreshInput" type="checkbox">
                    Force series episode refresh
                </label>
                <div class="button-row">
                    <button id="authorizeBtn" class="secondary" type="button">Check Access</button>
                    <button id="syncBtn" class="primary" type="button">Sync DB</button>
                </div>
            </section>
        </div>

        <pre id="logOutput" class="log" aria-live="polite"></pre>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
    <script>${readNormalizerSource()}</script>
    <script>
        const EMBEDDED = ${serializeInlineJson(embedded)};
        const logOutput = document.getElementById('logOutput');
        const authStatus = document.getElementById('authStatus');
        const snapshotStatus = document.getElementById('snapshotStatus');
        const snapshotMeta = document.getElementById('snapshotMeta');
        const emailInput = document.getElementById('emailInput');
        const passwordInput = document.getElementById('passwordInput');
        const loginBtn = document.getElementById('loginBtn');
        const logoutBtn = document.getElementById('logoutBtn');
        const authorizeBtn = document.getElementById('authorizeBtn');
        const syncBtn = document.getElementById('syncBtn');
        const forceSeriesRefreshInput = document.getElementById('forceSeriesRefreshInput');

        const supabaseClient = window.supabase.createClient(
            EMBEDDED.supabase.url,
            EMBEDDED.supabase.publishableKey
        );
        const SERIES_INFO_CONCURRENCY = 4;
        const SERIES_INFO_PROGRESS_STEP = 25;

        function log(line) {
            logOutput.textContent += (logOutput.textContent ? '\\n' : '') + line;
            logOutput.scrollTop = logOutput.scrollHeight;
        }

        function setAuthStatus(message, good) {
            authStatus.textContent = message;
            authStatus.className = 'status-line ' + (good ? 'status-good' : 'status-bad');
        }

        function setSnapshotStatus(message, good) {
            snapshotStatus.textContent = message;
            snapshotStatus.className = 'status-line ' + (good ? 'status-good' : 'status-bad');
        }

        async function getAccessToken() {
            const { data } = await supabaseClient.auth.getSession();
            return data.session?.access_token || '';
        }

        async function sessionCheck() {
            const token = await getAccessToken();
            if (!token) {
                setAuthStatus('Not signed in.', false);
                return null;
            }

            const response = await fetch(EMBEDDED.endpoints.sessionCheck, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + token
                }
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                setAuthStatus(payload.message || 'Session check failed.', false);
                return null;
            }
            setAuthStatus('Signed in as ' + payload.user.email + ' (allowlisted)', true);
            return { token, session: payload };
        }

        async function authorizeRefresh() {
            const auth = await sessionCheck();
            if (!auth) {
                setSnapshotStatus('Sign in with an allowlisted email first.', false);
                return null;
            }

            const response = await fetch(EMBEDDED.endpoints.authorizeRefresh, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + auth.token
                }
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const nextAllowed = payload.nextAllowedSyncAt ? ' Next allowed: ' + payload.nextAllowedSyncAt : '';
                setSnapshotStatus((payload.message || 'Refresh is not allowed right now.') + nextAllowed, false);
                snapshotMeta.textContent = '';
                return null;
            }

            setSnapshotStatus(payload.canRefresh ? 'Refresh allowed.' : 'Refresh blocked.', !!payload.canRefresh);
            snapshotMeta.textContent =
                'Last synced: ' + (payload.lastRefreshedAt || 'never') +
                ' • Next allowed: ' + (payload.nextAllowedSyncAt || 'now');
            return { token: auth.token, authorization: payload };
        }

        async function login() {
            const email = emailInput.value.trim();
            const password = passwordInput.value;
            if (!email || !password) {
                setAuthStatus('Email and password are required.', false);
                return;
            }

            const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) {
                setAuthStatus(error.message || 'Login failed.', false);
                return;
            }

            passwordInput.value = '';
            log('Signed in.');
            await authorizeRefresh();
        }

        async function logout() {
            await supabaseClient.auth.signOut();
            setAuthStatus('Signed out.', false);
            setSnapshotStatus('Refresh permission unknown.', false);
            snapshotMeta.textContent = '';
            log('Signed out.');
        }

        async function fetchJson(url, label) {
            log('Fetching ' + label + ': ' + url);
            const response = await fetch(url);
            if (!response.ok) throw new Error(label + ' HTTP ' + response.status);
            return response.json();
        }

        async function fetchText(url, label) {
            log('Fetching ' + label + ': ' + url);
            const response = await fetch(url);
            if (!response.ok) throw new Error(label + ' HTTP ' + response.status);
            return response.text();
        }

        async function fetchCategoryMap(baseApiUrl, action) {
            try {
                const rows = await fetchJson(baseApiUrl + '&action=' + action, action);
                const map = {};
                if (Array.isArray(rows)) {
                    rows.forEach((row) => {
                        if (row && row.category_id && row.category_name) {
                            map[row.category_id] = row.category_name;
                        }
                    });
                }
                log('Loaded ' + Object.keys(map).length + ' rows for ' + action + '.');
                return map;
            } catch (error) {
                log('Category fetch skipped for ' + action + ': ' + error.message);
                return {};
            }
        }

        async function fetchCurrentSnapshot() {
            const response = await fetch(EMBEDDED.endpoints.readSnapshot, {
                cache: 'no-store'
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.message || 'Failed to load the current snapshot');
            }
            return payload;
        }

        function mapItemsById(items) {
            const map = new Map();
            (Array.isArray(items) ? items : []).forEach((item) => {
                if (item && item.id) {
                    map.set(item.id, item);
                }
            });
            return map;
        }

        function getExistingSeriesInfo(seriesInfoIndex, seriesId) {
            if (!seriesInfoIndex || typeof seriesInfoIndex !== 'object') return null;
            const key = String(seriesId || '').trim();
            if (!key) return null;
            return seriesInfoIndex[key] || seriesInfoIndex['iptv_series_' + key] || null;
        }

        function normalizeExistingSeriesInfoValue(value) {
            if (!value) return null;
            if (Array.isArray(value)) {
                return { videos: value, info: null };
            }
            if (typeof value === 'object') {
                return {
                    videos: Array.isArray(value.videos) ? value.videos : [],
                    info: value.info || null
                };
            }
            return null;
        }

        function reuseNormalizedEntry(nextEntry, existingMap, counters) {
            const existingEntry = existingMap.get(nextEntry.id);
            if (existingEntry &&
                window.SnapshotNormalizer.fingerprintMediaItem(existingEntry) ===
                    window.SnapshotNormalizer.fingerprintMediaItem(nextEntry)) {
                counters.reused += 1;
                return existingEntry;
            }

            counters.changed += 1;
            return nextEntry;
        }

        async function mapWithConcurrency(items, limit, worker) {
            if (!Array.isArray(items) || items.length === 0) return [];

            const results = new Array(items.length);
            let nextIndex = 0;

            async function runWorker() {
                while (true) {
                    const currentIndex = nextIndex;
                    nextIndex += 1;
                    if (currentIndex >= items.length) return;
                    results[currentIndex] = await worker(items[currentIndex], currentIndex);
                }
            }

            const workers = [];
            const workerCount = Math.max(1, Math.min(limit, items.length));
            for (let i = 0; i < workerCount; i += 1) {
                workers.push(runWorker());
            }
            await Promise.all(workers);
            return results;
        }

        async function hydrateSeriesInfo(workItems, baseApiUrl, sourceConfig, existingSeriesInfoIndex) {
            const nextSeriesInfoIndex = {};
            const counters = {
                reused: 0,
                refreshed: 0,
                fallback: 0,
                empty: 0
            };

            const changedItems = [];
            workItems.forEach((item) => {
                if (item.reuseExistingInfo) {
                    nextSeriesInfoIndex[item.seriesKey] = item.reuseExistingInfo;
                    counters.reused += 1;
                    return;
                }
                changedItems.push(item);
            });

            if (changedItems.length === 0) {
                return { nextSeriesInfoIndex, counters };
            }

            log(
                'Refreshing episode data for ' +
                changedItems.length +
                ' changed/new series (' +
                counters.reused +
                ' reused).'
            );

            await mapWithConcurrency(changedItems, SERIES_INFO_CONCURRENCY, async (item, index) => {
                const label = '[' + (index + 1) + '/' + changedItems.length + '] ';
                const shouldLogProgress =
                    index === 0 ||
                    index === changedItems.length - 1 ||
                    ((index + 1) % SERIES_INFO_PROGRESS_STEP) === 0;
                try {
                    if (shouldLogProgress) {
                        log(label + 'Refreshing series info: ' + item.entry.name);
                    }
                    const infoJson = await fetchJson(
                        baseApiUrl + '&action=get_series_info&series_id=' + encodeURIComponent(item.seriesKey),
                        'series info ' + item.entry.name
                    );
                    const normalizedInfo = window.SnapshotNormalizer.normalizeSeriesInfoEntry({
                        xtreamUrl: sourceConfig.xtreamUrl,
                        xtreamUsername: sourceConfig.xtreamUsername,
                        xtreamPassword: sourceConfig.xtreamPassword,
                        seriesId: item.seriesKey,
                        infoJson,
                        fallbackSeries: item.entry
                    });
                    nextSeriesInfoIndex[item.seriesKey] = normalizedInfo;
                    counters.refreshed += 1;
                    if (shouldLogProgress) {
                        log(label + 'Episode data updated: ' + item.entry.name + ' (' + normalizedInfo.videos.length + ' episodes)');
                    }
                } catch (error) {
                    const fallback = normalizeExistingSeriesInfoValue(getExistingSeriesInfo(existingSeriesInfoIndex, item.seriesKey));
                    if (fallback) {
                        nextSeriesInfoIndex[item.seriesKey] = fallback;
                        counters.fallback += 1;
                        log(label + 'Series info refresh failed, reused cached data for ' + item.entry.name + ': ' + error.message);
                        return;
                    }

                    nextSeriesInfoIndex[item.seriesKey] = { videos: [], info: null };
                    counters.empty += 1;
                    log(label + 'Series info refresh failed for ' + item.entry.name + ': ' + error.message);
                }
            });

            return { nextSeriesInfoIndex, counters };
        }

        async function runSync() {
            log('Preparing sync...');
            const auth = await authorizeRefresh();
            if (!auth || !auth.authorization.canRefresh) return;

            const sourceConfig = EMBEDDED.sourceConfig;
            const startedAt = Date.now();
            const baseApiUrl =
                sourceConfig.xtreamUrl +
                '/player_api.php?username=' + encodeURIComponent(sourceConfig.xtreamUsername) +
                '&password=' + encodeURIComponent(sourceConfig.xtreamPassword);
            const forceSeriesRefresh = !!forceSeriesRefreshInput.checked;

            try {
                let existingSnapshotData = {};
                try {
                    const existingSnapshot = await fetchCurrentSnapshot();
                    existingSnapshotData = existingSnapshot?.snapshotData || {};
                    log(
                        'Loaded current snapshot: ' +
                        (Array.isArray(existingSnapshotData.channels) ? existingSnapshotData.channels.length : 0) + ' live, ' +
                        (Array.isArray(existingSnapshotData.movies) ? existingSnapshotData.movies.length : 0) + ' vod, ' +
                        (Array.isArray(existingSnapshotData.series) ? existingSnapshotData.series.length : 0) + ' series.'
                    );
                } catch (error) {
                    log('Current snapshot could not be loaded, proceeding with a cold rebuild: ' + error.message);
                }

                const [liveStreams, vodStreams, seriesList, liveCategories, vodCategories, seriesCategories] = await Promise.all([
                    fetchJson(baseApiUrl + '&action=get_live_streams', 'live streams'),
                    fetchJson(baseApiUrl + '&action=get_vod_streams', 'vod streams'),
                    sourceConfig.includeSeries === false
                        ? Promise.resolve([])
                        : fetchJson(baseApiUrl + '&action=get_series', 'series list').catch((error) => {
                            log('Series list skipped: ' + error.message);
                            return [];
                        }),
                    fetchCategoryMap(baseApiUrl, 'get_live_categories'),
                    fetchCategoryMap(baseApiUrl, 'get_vod_categories'),
                    sourceConfig.includeSeries === false ? Promise.resolve({}) : fetchCategoryMap(baseApiUrl, 'get_series_categories')
                ]);

                const existingChannelsById = mapItemsById(existingSnapshotData.channels);
                const existingMoviesById = mapItemsById(existingSnapshotData.movies);
                const existingSeriesById = mapItemsById(existingSnapshotData.series);
                const existingSeriesInfoIndex =
                    existingSnapshotData.seriesInfoIndex && typeof existingSnapshotData.seriesInfoIndex === 'object'
                        ? existingSnapshotData.seriesInfoIndex
                        : {};

                const liveCounters = { reused: 0, changed: 0 };
                const normalizedChannels = (Array.isArray(liveStreams) ? liveStreams : []).map((stream) => reuseNormalizedEntry(
                    window.SnapshotNormalizer.normalizeLiveStream(stream, {
                        xtreamUrl: sourceConfig.xtreamUrl,
                        xtreamUsername: sourceConfig.xtreamUsername,
                        xtreamPassword: sourceConfig.xtreamPassword,
                        liveCategories
                    }),
                    existingChannelsById,
                    liveCounters
                ));

                const vodCounters = { reused: 0, changed: 0 };
                const normalizedMovies = (Array.isArray(vodStreams) ? vodStreams : []).map((stream) => reuseNormalizedEntry(
                    window.SnapshotNormalizer.normalizeVodStream(stream, {
                        xtreamUrl: sourceConfig.xtreamUrl,
                        xtreamUsername: sourceConfig.xtreamUsername,
                        xtreamPassword: sourceConfig.xtreamPassword,
                        vodCategories
                    }),
                    existingMoviesById,
                    vodCounters
                ));

                const normalizedSeries = [];
                const seriesWorkItems = [];
                const seriesCounters = { reused: 0, changed: 0 };

                if (sourceConfig.includeSeries !== false) {
                    (Array.isArray(seriesList) ? seriesList : []).forEach((stream) => {
                        const nextSeriesEntry = reuseNormalizedEntry(
                            window.SnapshotNormalizer.normalizeSeriesEntry(stream, { seriesCategories }),
                            existingSeriesById,
                            seriesCounters
                        );
                        normalizedSeries.push(nextSeriesEntry);

                        const existingInfo = normalizeExistingSeriesInfoValue(
                            getExistingSeriesInfo(existingSeriesInfoIndex, stream.series_id)
                        );
                        const existingSeriesEntry = existingSeriesById.get(nextSeriesEntry.id);
                        const canReuseSeriesInfo = !forceSeriesRefresh &&
                            existingInfo &&
                            existingSeriesEntry &&
                            window.SnapshotNormalizer.fingerprintMediaItem(existingSeriesEntry) ===
                                window.SnapshotNormalizer.fingerprintMediaItem(nextSeriesEntry);

                        seriesWorkItems.push({
                            seriesKey: String(stream.series_id),
                            entry: nextSeriesEntry,
                            reuseExistingInfo: canReuseSeriesInfo ? existingInfo : null
                        });
                    });
                }

                let epgXmlText = '';
                if (sourceConfig.epgMode === 'custom' && sourceConfig.customEpgUrl) {
                    epgXmlText = await fetchText(sourceConfig.customEpgUrl, 'custom EPG');
                } else if (sourceConfig.epgMode === 'xtream') {
                    epgXmlText = await fetchText(
                        sourceConfig.xtreamUrl +
                            '/xmltv.php?username=' + encodeURIComponent(sourceConfig.xtreamUsername) +
                            '&password=' + encodeURIComponent(sourceConfig.xtreamPassword),
                        'panel EPG'
                    );
                }

                const seriesInfoResult = sourceConfig.includeSeries === false
                    ? {
                        nextSeriesInfoIndex: {},
                        counters: { reused: 0, refreshed: 0, fallback: 0, empty: 0 }
                    }
                    : await hydrateSeriesInfo(seriesWorkItems, baseApiUrl, sourceConfig, existingSeriesInfoIndex);

                const normalized = window.SnapshotNormalizer.normalizeSnapshot({
                    channels: normalizedChannels,
                    movies: normalizedMovies,
                    series: normalizedSeries,
                    epgXmlText,
                    includeSeries: sourceConfig.includeSeries,
                    seriesInfoIndex: seriesInfoResult.nextSeriesInfoIndex,
                    lastDurationMs: Date.now() - startedAt
                });

                log(
                    'Reuse summary: ' +
                    liveCounters.reused + ' live reused, ' +
                    vodCounters.reused + ' vod reused, ' +
                    seriesCounters.reused + ' series reused.'
                );
                log(
                    'Series episodes: ' +
                    seriesInfoResult.counters.reused + ' reused, ' +
                    seriesInfoResult.counters.refreshed + ' refreshed, ' +
                    seriesInfoResult.counters.fallback + ' fallback, ' +
                    seriesInfoResult.counters.empty + ' empty.'
                );
                log(
                    'Normalized snapshot: ' +
                    normalized.stats.liveCount + ' live, ' +
                    normalized.stats.vodCount + ' vod, ' +
                    normalized.stats.seriesCount + ' series, ' +
                    normalized.stats.epgProgrammes + ' programmes.'
                );

                const uploadResponse = await fetch(EMBEDDED.endpoints.upload, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer ' + auth.token
                    },
                    body: JSON.stringify({
                        snapshotData: normalized.snapshotData,
                        stats: normalized.stats
                    })
                });

                const payload = await uploadResponse.json().catch(() => ({}));
                if (!uploadResponse.ok) {
                    const nextAllowed = payload.nextAllowedSyncAt ? ' Next allowed: ' + payload.nextAllowedSyncAt : '';
                    throw new Error((payload.message || 'Upload failed.') + nextAllowed);
                }

                log('Upload complete.');
                log('Last refreshed at: ' + payload.lastRefreshedAt);
                log('Next allowed sync: ' + payload.nextAllowedSyncAt);
                setSnapshotStatus('Snapshot upload succeeded.', true);
                snapshotMeta.textContent =
                    'Last synced: ' + payload.lastRefreshedAt +
                    ' • Next allowed: ' + payload.nextAllowedSyncAt;
            } catch (error) {
                setSnapshotStatus(error.message || 'Sync failed.', false);
                log('Sync failed: ' + (error.message || error));
            }
        }

        loginBtn.addEventListener('click', login);
        logoutBtn.addEventListener('click', logout);
        authorizeBtn.addEventListener('click', authorizeRefresh);
        syncBtn.addEventListener('click', runSync);

        supabaseClient.auth.onAuthStateChange(() => {
            sessionCheck().catch(() => {});
        });

        log('Snapshot: ' + EMBEDDED.snapshotTitle);
        log('Xtream URL: ' + EMBEDDED.sourceConfig.xtreamUrl);
        log('Use this file locally. It is expected to run outside the hosted BeamUp page.');
        sessionCheck().then((auth) => {
            if (auth) return authorizeRefresh();
            return null;
        }).catch((error) => {
            log('Initial session check failed: ' + error.message);
        });
    </script>
</body>
</html>`;
}

module.exports = {
    renderSnapshotSyncFile
};
