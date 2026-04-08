const { getServiceSupabase } = require('./supabaseClient');
const { getDefaultXtreamSourceConfig } = require('./snapshotSourceConfig');
const {
    expandSnapshotData,
    prepareSnapshotDataForTransport
} = require('./snapshotCompression');

const SNAPSHOT_PROVIDER = 'xtream';
const SNAPSHOT_REFRESH_COOLDOWN_MINUTES = 30;
const PRIMARY_SNAPSHOT_SLUG = 'primary';
const PRIMARY_SNAPSHOT_TITLE = 'Main IPTV Snapshot';
const INSTALL_CODE_KEY = 'install_code';
const DEFAULT_INSTALL_CODE = 'potato';

function addMinutes(isoString, minutes) {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;
    return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function computeNextAllowedAt(lastRefreshedAt) {
    return addMinutes(lastRefreshedAt, SNAPSHOT_REFRESH_COOLDOWN_MINUTES);
}

function sanitizePublicSnapshotRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        provider: row.provider,
        snapshotData: expandSnapshotData(row.snapshot_data || {}),
        stats: row.stats || {},
        lastRefreshedAt: row.last_refreshed_at || null,
        nextAllowedSyncAt: computeNextAllowedAt(row.last_refreshed_at)
    };
}

function sanitizeSnapshotStatus(row) {
    if (!row) return null;
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        provider: row.provider,
        stats: row.stats || {},
        lastRefreshedAt: row.last_refreshed_at || null,
        nextAllowedSyncAt: computeNextAllowedAt(row.last_refreshed_at),
        canRefresh: !row.last_refreshed_at || Date.parse(computeNextAllowedAt(row.last_refreshed_at)) <= Date.now()
    };
}

function emptySnapshotData() {
    return {
        channels: [],
        movies: [],
        series: [],
        epgData: {},
        seriesInfoIndex: {}
    };
}

function normalizeSourceConfig(input = {}) {
    const xtreamUrl = String(input.xtreamUrl || '').trim().replace(/\/+$/, '');
    const xtreamUsername = String(input.xtreamUsername || '').trim();
    const xtreamPassword = String(input.xtreamPassword || '');
    const enableEpg = input.enableEpg === true;
    const epgMode = enableEpg ? (input.epgMode === 'custom' ? 'custom' : 'xtream') : 'disabled';
    const customEpgUrl = epgMode === 'custom' ? String(input.customEpgUrl || '').trim() : '';

    if (!xtreamUrl || !/^https?:\/\//i.test(xtreamUrl)) {
        throw new Error('A valid Xtream base URL is required');
    }
    if (!xtreamUsername) throw new Error('Xtream username is required');
    if (!xtreamPassword) throw new Error('Xtream password is required');
    if (epgMode === 'custom' && (!customEpgUrl || !/^https?:\/\//i.test(customEpgUrl))) {
        throw new Error('A valid custom EPG URL is required when custom EPG mode is selected');
    }

    return {
        xtreamUrl,
        xtreamUsername,
        xtreamPassword,
        epgMode,
        customEpgUrl,
        includeSeries: input.includeSeries !== false
    };
}

async function getAppConfigValue(key, defaultValue = '') {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', key)
        .maybeSingle();

    if (error) {
        throw new Error(error.message || 'Failed to read app configuration');
    }

    if (data?.value) return String(data.value);

    const { error: insertError } = await supabase
        .from('app_config')
        .upsert({
            key,
            value: defaultValue
        }, {
            onConflict: 'key'
        });

    if (insertError) {
        throw new Error(insertError.message || 'Failed to initialize app configuration');
    }

    return String(defaultValue || '');
}

async function getInstallCode() {
    return getAppConfigValue(INSTALL_CODE_KEY, DEFAULT_INSTALL_CODE);
}

function normalizeInstallCode(value) {
    return String(value || '').trim();
}

async function verifyInstallCode(candidate) {
    const expected = normalizeInstallCode(await getInstallCode());
    const actual = normalizeInstallCode(candidate);
    return !!expected && actual === expected;
}

async function ensurePrimarySnapshot() {
    const supabase = getServiceSupabase();
    const managedSourceConfig = normalizeSourceConfig(getDefaultXtreamSourceConfig());
    const selectFields = 'id, slug, title, provider, source_config, snapshot_data, stats, last_refreshed_at, created_at';

    const { data: existingPrimary, error: primaryError } = await supabase
        .from('xtream_snapshots')
        .select(selectFields)
        .eq('slug', PRIMARY_SNAPSHOT_SLUG)
        .maybeSingle();

    if (primaryError) {
        throw new Error(primaryError.message || 'Failed to load primary snapshot');
    }

    if (existingPrimary) {
        const currentSourceConfig = JSON.stringify(existingPrimary.source_config || {});
        const desiredSourceConfig = JSON.stringify(managedSourceConfig);
        if (currentSourceConfig !== desiredSourceConfig || existingPrimary.title !== PRIMARY_SNAPSHOT_TITLE) {
            const { data: updated, error: updateError } = await supabase
                .from('xtream_snapshots')
                .update({
                    title: PRIMARY_SNAPSHOT_TITLE,
                    source_config: managedSourceConfig
                })
                .eq('id', existingPrimary.id)
                .select(selectFields)
                .single();

            if (updateError) {
                throw new Error(updateError.message || 'Failed to update primary snapshot');
            }

            return updated;
        }

        return existingPrimary;
    }

    const { data: candidate, error: candidateError } = await supabase
        .from('xtream_snapshots')
        .select(selectFields)
        .order('last_refreshed_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (candidateError) {
        throw new Error(candidateError.message || 'Failed to locate a primary snapshot candidate');
    }

    if (candidate) {
        const { data: updated, error: updateError } = await supabase
            .from('xtream_snapshots')
            .update({
                slug: PRIMARY_SNAPSHOT_SLUG,
                title: PRIMARY_SNAPSHOT_TITLE,
                source_config: managedSourceConfig
            })
            .eq('id', candidate.id)
            .select(selectFields)
            .single();

        if (updateError) {
            throw new Error(updateError.message || 'Failed to promote primary snapshot');
        }

        return updated;
    }

    const { data: inserted, error: insertError } = await supabase
        .from('xtream_snapshots')
        .insert({
            slug: PRIMARY_SNAPSHOT_SLUG,
            title: PRIMARY_SNAPSHOT_TITLE,
            provider: SNAPSHOT_PROVIDER,
            source_config: managedSourceConfig,
            snapshot_data: emptySnapshotData(),
            stats: {}
        })
        .select(selectFields)
        .single();

    if (insertError) {
        throw new Error(insertError.message || 'Failed to create primary snapshot');
    }

    return inserted;
}

async function getPrimarySnapshotStatus() {
    const snapshot = await ensurePrimarySnapshot();
    return sanitizeSnapshotStatus(snapshot);
}

async function getPrimarySnapshotForPublicRead() {
    const snapshot = await ensurePrimarySnapshot();
    return sanitizePublicSnapshotRow(snapshot);
}

async function getPrimarySnapshotForAddon() {
    const snapshot = await ensurePrimarySnapshot();
    return {
        id: snapshot.id,
        title: snapshot.title,
        slug: snapshot.slug,
        snapshot_data: expandSnapshotData(snapshot.snapshot_data || {}),
        stats: snapshot.stats || {},
        last_refreshed_at: snapshot.last_refreshed_at || null
    };
}

async function getPrimarySnapshotForSyncDownload() {
    const snapshot = await ensurePrimarySnapshot();
    const sourceConfig = normalizeSourceConfig(getDefaultXtreamSourceConfig());
    return {
        id: snapshot.id,
        slug: snapshot.slug,
        title: snapshot.title,
        provider: snapshot.provider,
        sourceConfig,
        stats: snapshot.stats || {},
        lastRefreshedAt: snapshot.last_refreshed_at || null,
        nextAllowedSyncAt: computeNextAllowedAt(snapshot.last_refreshed_at)
    };
}

async function overwriteSnapshot({ snapshotId, user, snapshotData, stats }) {
    const supabase = getServiceSupabase();
    const preparedSnapshotData = await prepareSnapshotDataForTransport(snapshotData);
    const { data, error } = await supabase.rpc('overwrite_xtream_snapshot', {
        p_snapshot_id: snapshotId,
        p_user_id: user.id,
        p_user_email: user.email,
        p_snapshot_data: preparedSnapshotData,
        p_stats: stats || {}
    });

    if (error) {
        const message = error.message || 'Snapshot upload failed';
        const cooldownMatch = message.match(/Cooldown active until (.+)$/i);
        if (cooldownMatch) {
            const cooldownError = new Error('Snapshot refresh is cooling down');
            cooldownError.code = 'snapshot_cooldown';
            cooldownError.nextAllowedSyncAt = cooldownMatch[1];
            throw cooldownError;
        }
        throw new Error(message);
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
        id: row.id,
        title: row.title,
        slug: row.slug,
        stats: row.stats || {},
        lastRefreshedAt: row.last_refreshed_at,
        nextAllowedSyncAt: row.next_allowed_at
    };
}

async function overwritePrimarySnapshot({ user, snapshotData, stats }) {
    const snapshot = await ensurePrimarySnapshot();
    return overwriteSnapshot({
        snapshotId: snapshot.id,
        user,
        snapshotData,
        stats
    });
}

module.exports = {
    DEFAULT_INSTALL_CODE,
    PRIMARY_SNAPSHOT_SLUG,
    SNAPSHOT_REFRESH_COOLDOWN_MINUTES,
    computeNextAllowedAt,
    ensurePrimarySnapshot,
    emptySnapshotData,
    getInstallCode,
    getPrimarySnapshotForAddon,
    getPrimarySnapshotForPublicRead,
    getPrimarySnapshotForSyncDownload,
    getPrimarySnapshotStatus,
    normalizeSourceConfig,
    overwritePrimarySnapshot,
    overwriteSnapshot,
    verifyInstallCode
};
