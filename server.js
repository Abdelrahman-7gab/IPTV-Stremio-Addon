// Server for IPTV Stremio Addon (with debug + prefetch proxy to bypass browser CORS for pre-flight)
// Updated: Fixed prefetch stream handling (node-fetch readable stream -> chunk accumulation, no getReader()).
require('dotenv').config();

const { getRouter } = require('stremio-addon-sdk');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const createAddon = require('./addon');
const { encryptConfig, tryParseConfigToken } = require('./cryptoConfig');
const LRUCache = require('./lruCache');
const { normalizeSdkResourceUrl } = require('./sdkUrlUtils');
const { getPublicSupabaseConfig } = require('./supabaseClient');
const { requireAllowlistedSnapshotUser, writeSnapshotAuthError } = require('./snapshotAuth');
const { getPublicSnapshotSourceInfo } = require('./snapshotSourceConfig');
const {
    getPrimarySnapshotForPublicRead,
    getPrimarySnapshotForSyncDownload,
    getPrimarySnapshotStatus,
    overwritePrimarySnapshot,
    verifyInstallCode
} = require('./snapshotStore');
const { renderSnapshotSyncFile } = require('./snapshotSyncTemplate');

const DEBUG = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';
function dlog(...args) {
    if (DEBUG) console.log('[DEBUG]', ...args);
}

let redisClient = null;
if (process.env.REDIS_URL) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
        redisClient.on('error', e => console.error('[REDIS] Error:', e.message));
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err.message));
        console.log('[REDIS] Enabled (interface cache)');
    } catch (e) {
        console.warn('[REDIS] ioredis not available, fallback to in-memory LRU');
        redisClient = null;
    }
}

const INTERFACE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const interfaceCache = new LRUCache({ max: parseInt(process.env.MAX_CACHE_ENTRIES || '100', 10), ttl: INTERFACE_TTL_MS });
const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';

const PREFETCH_MAX_BYTES = parseInt(process.env.PREFETCH_MAX_BYTES || '150000000', 10);
const PREFETCH_ENABLED = (process.env.PREFETCH_ENABLED || 'true').toLowerCase() !== 'false';
const SNAPSHOT_UPLOAD_LIMIT = process.env.SNAPSHOT_UPLOAD_LIMIT || '100mb';

const app = express();
const staticDir = path.join(__dirname, 'src');
app.use(express.static(staticDir));
app.use(express.json({ limit: SNAPSHOT_UPLOAD_LIMIT }));

app.use((req, res, next) => {
    res.setHeader('X-App', 'IPTV-Stremio-Addon');
    next();
});

function getRequestOrigin(req) {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = (typeof forwardedProto === 'string' && forwardedProto.trim()) || req.protocol;
    return `${protocol}://${req.get('host')}`;
}

async function handlePrimarySnapshotRefreshAuthorize(req, res) {
    try {
        await requireAllowlistedSnapshotUser(req);
        const snapshot = await getPrimarySnapshotStatus();

        if (!snapshot.canRefresh) {
            return res.status(429).json({
                error: 'snapshot_cooldown',
                message: 'Snapshot refresh is cooling down',
                lastRefreshedAt: snapshot.lastRefreshedAt,
                nextAllowedSyncAt: snapshot.nextAllowedSyncAt,
                canRefresh: false
            });
        }

        return res.json({
            canRefresh: true,
            lastRefreshedAt: snapshot.lastRefreshedAt,
            nextAllowedSyncAt: snapshot.nextAllowedSyncAt,
            snapshot
        });
    } catch (error) {
        if (error?.statusCode) return writeSnapshotAuthError(res, error);
        return res.status(500).json({
            error: 'snapshot_authorize_failed',
            message: error.message || 'Failed to authorize snapshot refresh'
        });
    }
}

async function handlePrimarySnapshotUpload(req, res) {
    try {
        const user = await requireAllowlistedSnapshotUser(req);
        const snapshotData = req.body?.snapshotData;
        const stats = req.body?.stats || {};

        if (!snapshotData || typeof snapshotData !== 'object') {
            return res.status(400).json({
                error: 'invalid_snapshot_payload',
                message: 'snapshotData is required'
            });
        }

        const result = await overwritePrimarySnapshot({
            user,
            snapshotData,
            stats
        });

        return res.json(result);
    } catch (error) {
        if (error?.statusCode) return writeSnapshotAuthError(res, error);
        if (error?.code === 'snapshot_cooldown') {
            return res.status(429).json({
                error: 'snapshot_cooldown',
                message: 'Snapshot refresh is cooling down',
                nextAllowedSyncAt: error.nextAllowedSyncAt || null
            });
        }
        return res.status(500).json({
            error: 'snapshot_upload_failed',
            message: error.message || 'Failed to upload snapshot'
        });
    }
}

async function handlePrimarySnapshotDownload(req, res) {
    try {
        const user = await requireAllowlistedSnapshotUser(req);
        const snapshot = await getPrimarySnapshotForSyncDownload();

        const html = renderSnapshotSyncFile({
            snapshot,
            publicConfig: getPublicSupabaseConfig(),
            appOrigin: getRequestOrigin(req),
            defaultEmail: user.email
        });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${snapshot.slug || snapshot.id}-sync.html"`);
        return res.send(html);
    } catch (error) {
        if (error?.statusCode) return writeSnapshotAuthError(res, error);
        return res.status(500).json({
            error: 'sync_file_failed',
            message: error.message || 'Failed to generate sync file'
        });
    }
}

app.get('/api/public-config', (req, res) => {
    try {
        return res.json({
            supabase: getPublicSupabaseConfig(),
            snapshotSource: getPublicSnapshotSourceInfo()
        });
    } catch (error) {
        return res.status(500).json({
            error: 'supabase_config_missing',
            message: error.message
        });
    }
});

app.get('/api/snapshot', async (req, res) => {
    try {
        const snapshot = await getPrimarySnapshotStatus();
        return res.json(snapshot);
    } catch (error) {
        return res.status(500).json({
            error: 'snapshot_status_failed',
            message: error.message || 'Failed to load primary snapshot'
        });
    }
});

app.post('/api/install/authorize', async (req, res) => {
    try {
        const code = String(req.body?.code || '');
        const isValid = await verifyInstallCode(code);
        if (!isValid) {
            return res.status(403).json({
                ok: false,
                error: 'invalid_install_code',
                message: 'The secret code is invalid'
            });
        }

        const snapshot = await getPrimarySnapshotStatus();
        return res.json({
            ok: true,
            snapshot
        });
    } catch (error) {
        return res.status(500).json({
            error: 'install_authorize_failed',
            message: error.message || 'Failed to verify the install code'
        });
    }
});

app.post('/api/auth/session-check', async (req, res) => {
    try {
        const user = await requireAllowlistedSnapshotUser(req);
        return res.json({
            authenticated: true,
            allowlisted: true,
            user: {
                id: user.id,
                email: user.email
            }
        });
    } catch (error) {
        return writeSnapshotAuthError(res, error);
    }
});

app.post('/api/snapshots', async (req, res) => {
    try {
        await requireAllowlistedSnapshotUser(req);
        const snapshot = await getPrimarySnapshotStatus();
        return res.status(200).json(snapshot);
    } catch (error) {
        if (error?.statusCode) return writeSnapshotAuthError(res, error);
        return res.status(400).json({
            error: 'snapshot_status_failed',
            message: error.message || 'Failed to load the primary snapshot'
        });
    }
});

app.get('/api/snapshots/:id', async (req, res) => {
    try {
        const snapshot = await getPrimarySnapshotForPublicRead();
        return res.json(snapshot);
    } catch (error) {
        return res.status(500).json({
            error: 'snapshot_read_failed',
            message: error.message || 'Failed to read snapshot'
        });
    }
});

app.post('/api/snapshot/refresh-authorize', handlePrimarySnapshotRefreshAuthorize);
app.post('/api/snapshots/:id/refresh-authorize', handlePrimarySnapshotRefreshAuthorize);
app.post('/api/snapshot/upload', handlePrimarySnapshotUpload);
app.post('/api/snapshots/:id/upload', handlePrimarySnapshotUpload);
app.get('/api/snapshot/download-sync-file', handlePrimarySnapshotDownload);
app.get('/api/snapshots/:id/download-sync-file', handlePrimarySnapshotDownload);

// Encryption endpoint
app.post('/encrypt', (req, res) => {
    if (!process.env.CONFIG_SECRET) {
        return res.status(400).json({ error: 'Encryption not enabled on server (CONFIG_SECRET missing)' });
    }
    try {
        const jsonStr = JSON.stringify(req.body || {});
        const token = encryptConfig(jsonStr);
        if (!token) return res.status(500).json({ error: 'Encrypt failed' });
        res.json({ token });
    } catch {
        res.status(400).json({ error: 'Invalid config payload' });
    }
});

/**
 * Prefetch endpoint: server-side fetch to bypass browser CORS for playlist / EPG pre-flight.
 * SECURITY: Basic SSRF protections included (blocks local/private networks).
 * NOTE: For production, consider a stricter allowlist or DNS/IP resolution checks.
 */
app.post('/api/prefetch', async (req, res) => {
    if (!PREFETCH_ENABLED) return res.status(403).json({ error: 'Prefetch disabled by server' });

    const { url, purpose } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Only http(s) URLs allowed' });

    try {
        const u = new URL(url);
        const host = u.hostname;
        // Basic SSRF / local network block
        if (
            host === 'localhost' ||
            host === '0.0.0.0' ||
            /^127\./.test(host) ||
            /^10\./.test(host) ||
            /^192\.168\./.test(host) ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
            /^169\.254\./.test(host)
        ) {
            return res.status(400).json({ error: 'Blocked host' });
        }

        dlog('Prefetch start', { url, purpose });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);

        let fetched;
        try {
            fetched = await fetch(url, {
                method: 'GET',
                signal: controller.signal,
                headers: { 'User-Agent': 'IPTV-Stremio-Addon Prefetch/1.1' }
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!fetched.ok) {
            dlog('Prefetch non-OK', fetched.status, url);
            return res.status(502).json({ error: `Fetch failed (${fetched.status})` });
        }

        // Accumulate stream with a byte limit
        const reader = fetched.body; // Node.js readable stream
        const chunks = [];
        let received = 0;
        let truncated = false;

        await new Promise((resolve, reject) => {
            reader.on('data', (chunk) => {
                received += chunk.length;
                if (received <= PREFETCH_MAX_BYTES) {
                    chunks.push(chunk);
                } else {
                    truncated = true;
                    // Stop reading further; destroy stream.
                    reader.destroy();
                }
            });
            reader.on('end', resolve);
            reader.on('close', resolve);
            reader.on('error', reject);
        });

        let content = Buffer.concat(chunks).toString('utf8');
        if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // strip BOM

        dlog('Prefetch done', { bytes: received, truncated, returnedBytes: Buffer.byteLength(content) });

        res.json({
            ok: true,
            bytes: received,
            truncated,
            purpose: purpose || null,
            content
        });
    } catch (e) {
        dlog('Prefetch error', e.message);
        res.status(500).json({
            error: 'Prefetch error',
            detail: DEBUG ? e.message : undefined
        });
    }
});

// Root & configuration pages
app.get('/', (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
});

app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/configure-direct', (req, res) => {
    return res.redirect('/configure-xtream');
});
app.get('/html/direct-config.html', (req, res) => {
    return res.redirect('/configure-xtream');
});
app.get('/configure-xtream', (req, res) => {
    const fileRoot = path.join(__dirname, 'xtream-config.html');
    res.sendFile(fileRoot, err => {
        if (err) res.sendFile(path.join(staticDir, 'html', 'xtream-config.html'));
    });
});

function maybeDecryptConfig(token) {
    return tryParseConfigToken(token);
}
function isConfigToken(token) {
    if (!token) return false;
    if (token.startsWith('enc:')) return true;
    if (token.length < 4) return false;
    return true;
}

// Legacy redirect
app.get('/:token/configure', (req, res) => {
    const { token } = req.params;
    if (!isConfigToken(token)) return res.status(400).json({ error: 'Invalid configuration' });
    return res.redirect(`/${encodeURIComponent(token)}/configure-xtream`);
});

app.get('/:token/configure-direct', (req, res) => {
    if (!isConfigToken(req.params.token)) return res.status(400).json({ error: 'Invalid token' });
    return res.redirect(`/${encodeURIComponent(req.params.token)}/configure-xtream`);
});
app.get('/:token/configure-xtream', (req, res) => {
    if (!isConfigToken(req.params.token)) return res.status(400).json({ error: 'Invalid token' });
    const fileRoot = path.join(__dirname, 'xtream-config.html');
    res.sendFile(fileRoot, err => {
        if (err) res.sendFile(path.join(staticDir, 'html', 'xtream-config.html'));
    });
});

// Token interface middleware
app.use('/:token', async (req, res, next) => {
    const { token } = req.params;
    if (!isConfigToken(token)) return next('route');
    if (req.path.startsWith('/configure')) return next();

    const originalUrl = req.url;
    req.url = normalizeSdkResourceUrl(req.url);
    if (DEBUG && originalUrl !== req.url) {
        console.log('[DEBUG] Normalized route', { originalUrl, normalizedUrl: req.url });
    }

    let config;
    try {
        config = maybeDecryptConfig(token);
    } catch (e) {
        dlog('Config parse failed', token, e.message);
        return res.status(400).json({ error: 'Invalid configuration token' });
    }
    if (!config.provider) config.provider = config.useXtream ? 'xtream' : 'direct';
    if (DEBUG && config.debug !== false) config.debug = true;

    if (config.provider === 'xtream_snapshot') {
        try {
            const isValidInstallCode = await verifyInstallCode(config.accessCode);
            if (!isValidInstallCode) {
                return res.status(403).json({
                    error: 'invalid_install_code',
                    message: 'The addon secret code is invalid'
                });
            }
        } catch (error) {
            return res.status(500).json({
                error: 'install_code_check_failed',
                message: error.message || 'Failed to validate the addon secret code'
            });
        }
    }

    const ifaceKey = 'iface:' + crypto.createHash('md5').update(token).digest('hex');

    async function redisGet(key) {
        if (!CACHE_ENABLED || !redisClient) return null;
        try { return await redisClient.get(key); } catch { return null; }
    }
    async function redisSet(key, ttl) {
        if (!CACHE_ENABLED || !redisClient) return;
        try { await redisClient.set(key, '1', 'PX', ttl); } catch { }
    }

    let iface = CACHE_ENABLED ? interfaceCache.get(ifaceKey) : null;
    if (!iface) {
        await redisGet(ifaceKey);
        try {
            dlog('Building addon interface (cache miss)', ifaceKey);
            iface = await createAddon(config);
            if (CACHE_ENABLED) {
                interfaceCache.set(ifaceKey, iface);
                await redisSet(ifaceKey, INTERFACE_TTL_MS);
            }
        } catch (e) {
            console.error('[SERVER] Addon build failed:', e);
            return res.status(500).json({ error: 'Addon build error' });
        }
    } else {
        dlog('Interface cache hit', ifaceKey);
    }

    req.addonInterface = iface;
    req.configToken = token;
    next();
});

// Logo proxy
app.get('/:token/logo/:tvgId.png', async (req, res) => {
    if (!req.addonInterface) {
        return res.redirect(`https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(req.params.tvgId)}`);
    }
    const sources = req.addonInterface._logoSources || [];
    if (!sources.length) {
        return res.redirect(`https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(req.params.tvgId)}`);
    }
    const { tvgId } = req.params;
    const rawId = tvgId;
    const noCountry = rawId.replace(/\.[a-z]{2,3}$/, '');
    const hyphenated = noCountry.replace(/[^a-zA-Z0-9]+/g, '-');
    const underscored = noCountry.replace(/[^a-zA-Z0-9]+/g, '_');
    const candidates = [...new Set([rawId, noCountry, hyphenated, underscored])];
    for (const cand of candidates) {
        for (const template of sources) {
            const url = template.replace('{id}', cand);
            try {
                let head = await fetch(url, { method: 'HEAD', timeout: 7000 });
                if (!head.ok) head = await fetch(url, { method: 'GET', timeout: 10000 });
                if (head.ok) {
                    const buf = await head.buffer();
                    if (buf.length > 50) {
                        const ct = head.headers.get('content-type') || 'image/png';
                        res.setHeader('Content-Type', ct);
                        res.setHeader('Cache-Control', 'public, max-age=21600');
                        return res.end(buf);
                    }
                }
            } catch { /* continue */ }
        }
    }
    res.redirect(`https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(noCountry.toUpperCase().slice(0, 12))}`);
});

// Stremio router
app.use('/:token', (req, res) => {
    const iface = req.addonInterface;
    if (!iface) return res.status(500).json({ error: 'Interface not ready' });

    // Prevent stale client behavior when the manifest shape changes.
    if (req.path === '/manifest.json') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        if (DEBUG) {
            const searchable = (iface.manifest?.catalogs || [])
                .filter(c =>
                    (Array.isArray(c.extra) && c.extra.some(e => e?.name === 'search')) ||
                    (Array.isArray(c.extraSupported) && c.extraSupported.includes('search'))
                )
                .map(c => `${c.type}:${c.id}`);
            console.log('[DEBUG] Manifest search catalogs', searchable);
        }
    }

    if (DEBUG) {
        const start = Date.now();
        res.on('finish', () => {
            console.log('[DEBUG] Routed request', {
                method: req.method,
                url: req.originalUrl,
                normalizedUrl: req.url,
                status: res.statusCode,
                ms: Date.now() - start,
                userAgent: req.headers['user-agent']
            });
        });
    }

    const router = getRouter(iface);
    router(req, res, (err) => {
        if (err) {
            console.error('[SERVER] Router error:', err);
            res.status(500).json({ error: 'Addon error' });
        } else {
            res.status(404).json({ error: 'Not found' });
        }
    });
});

app.use('*', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((error, req, res, next) => {
    console.error('[SERVER] Unhandled error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
    const port = process.env.PORT || 7000;
    app.listen(port, () => {
        console.log(`🚀 Server running on port ${port} (debug=${DEBUG}, prefetch=${PREFETCH_ENABLED})`);
    });
}

module.exports = app;
