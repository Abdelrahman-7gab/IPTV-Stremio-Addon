function readRequired(name, fallback = '') {
    const value = process.env[name] || fallback;
    if (!value) {
        throw new Error(`${name} is required for snapshot source configuration`);
    }
    return value;
}

function getDefaultXtreamSourceConfig() {
    return {
        xtreamUrl: readRequired('DEFAULT_XTREAM_URL', 'http://mhiptv.info:2095').replace(/\/+$/, ''),
        xtreamUsername: readRequired('DEFAULT_XTREAM_USERNAME', '01129347201').trim(),
        xtreamPassword: readRequired('DEFAULT_XTREAM_PASSWORD', '01129347201ab'),
        enableEpg: false,
        epgMode: 'disabled',
        customEpgUrl: '',
        includeSeries: true
    };
}

function getPublicSnapshotSourceInfo() {
    const source = getDefaultXtreamSourceConfig();
    return {
        label: 'Managed Xtream source',
        provider: 'xtream',
        xtreamUrl: source.xtreamUrl
    };
}

module.exports = {
    getDefaultXtreamSourceConfig,
    getPublicSnapshotSourceInfo
};
