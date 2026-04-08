const assert = require('assert');

function runSdkUrlUtilsTests() {
    const { normalizeSdkResourceUrl } = require('../sdkUrlUtils');

    assert.strictEqual(
        normalizeSdkResourceUrl('/catalog/series/iptv_series/search=foo&skip=100.json'),
        '/catalog/series/iptv_series/search=foo&skip=100.json'
    );

    assert.strictEqual(
        normalizeSdkResourceUrl('/catalog/series/iptv_series/search=foo/skip=100.json'),
        '/catalog/series/iptv_series/search=foo&skip=100.json'
    );

    assert.strictEqual(
        normalizeSdkResourceUrl('/catalog/series/iptv_series.json?search=%D8%A7%D9%84%D8%B5%D9%8A%D8%A7%D8%AF&skip=0'),
        '/catalog/series/iptv_series/search=%D8%A7%D9%84%D8%B5%D9%8A%D8%A7%D8%AF&skip=0.json'
    );

    assert.strictEqual(
        normalizeSdkResourceUrl('/catalog/series/iptv_series/search=%D8%A7%D9%84%D8%B5%D9%8A%D8%A7%D8%AF.json?_=123'),
        '/catalog/series/iptv_series/search=%D8%A7%D9%84%D8%B5%D9%8A%D8%A7%D8%AF&_=123.json'
    );

    assert.strictEqual(
        normalizeSdkResourceUrl('/meta/series/iptv_series_123.json?_=123'),
        '/meta/series/iptv_series_123.json'
    );

    assert.strictEqual(
        normalizeSdkResourceUrl('/manifest.json?_=123'),
        '/manifest.json?_=123'
    );
}

function invokeRouter(router, url) {
    return new Promise((resolve, reject) => {
        const headers = {};
        const req = {
            method: 'GET',
            url,
            headers: {}
        };
        const res = {
            statusCode: 200,
            setHeader(name, value) {
                headers[name] = value;
            },
            writeHead(statusCode) {
                this.statusCode = statusCode;
            },
            redirect(statusCode, location) {
                this.statusCode = statusCode;
                this.end(JSON.stringify({ redirect: location }));
            },
            end(body = '') {
                resolve({
                    statusCode: this.statusCode,
                    headers,
                    body: String(body)
                });
            }
        };

        router(req, res, (error) => {
            if (error) reject(error);
            else resolve({
                statusCode: res.statusCode,
                headers,
                body: ''
            });
        });
    });
}

async function runAddonBuildCacheTests() {
    process.env.CACHE_ENABLED = 'true';

    const directProvider = require('../src/js/providers/directProvider');
    const createAddon = require('../addon');

    const originalFetchData = directProvider.fetchData;
    let fetchDataCalls = 0;

    directProvider.fetchData = async (addonInstance) => {
        fetchDataCalls += 1;
        if (fetchDataCalls === 1) {
            throw new Error('forced initial fetch failure');
        }

        addonInstance.channels = [{
            id: 'iptv_test_channel',
            type: 'tv',
            name: 'Test Channel',
            url: 'http://example.com/live.m3u8',
            attributes: {}
        }];
        addonInstance.movies = [];
        addonInstance.series = [];
        addonInstance.epgData = {};
    };

    const config = {
        provider: 'direct',
        m3uUrl: 'http://example.com/playlist.m3u',
        includeSeries: false,
        enableEpg: false,
        debug: false
    };

    let firstAttemptFailed = false;
    try {
        await createAddon(config);
    } catch (error) {
        firstAttemptFailed = true;
        assert.match(error.message, /forced initial fetch failure/);
    }

    assert.strictEqual(firstAttemptFailed, true, 'first createAddon call should fail');

    const iface = await createAddon(config);
    const catalog = await iface.get('catalog', 'tv', 'iptv_channels', {}, {});

    assert.strictEqual(fetchDataCalls, 2, 'second createAddon call should rebuild instead of reusing a poisoned cache entry');
    assert.strictEqual(catalog.metas.length, 1);
    assert.strictEqual(catalog.metas[0].name, 'Test Channel');

    directProvider.fetchData = originalFetchData;
}

async function runSearchCompatibilityTests() {
    process.env.CACHE_ENABLED = 'true';

    const { getRouter } = require('stremio-addon-sdk');
    const { normalizeSdkResourceUrl } = require('../sdkUrlUtils');
    const directProvider = require('../src/js/providers/directProvider');
    const createAddon = require('../addon');

    const originalFetchData = directProvider.fetchData;

    directProvider.fetchData = async (addonInstance) => {
        addonInstance.channels = [];
        addonInstance.movies = [
            {
                id: 'iptv_movie_target',
                type: 'movie',
                name: 'Search Target',
                category: 'Movies',
                addedAt: '2026-01-03T00:00:00.000Z',
                attributes: {}
            },
            {
                id: 'iptv_movie_other',
                type: 'movie',
                name: 'Different Movie',
                category: 'Movies',
                addedAt: '2026-01-02T00:00:00.000Z',
                attributes: {}
            },
            {
                id: 'iptv_movie_query_match',
                type: 'movie',
                name: 'Shared Query Movie',
                category: 'Archive Movies',
                addedAt: '2025-01-01T00:00:00.000Z',
                attributes: {}
            }
        ];
        addonInstance.series = [
            {
                id: 'iptv_series_target',
                type: 'series',
                name: 'Search Target',
                category: 'Series',
                addedAt: '2026-02-03T00:00:00.000Z',
                attributes: {}
            },
            {
                id: 'iptv_series_other',
                type: 'series',
                name: 'Another Show',
                category: 'Series',
                addedAt: '2026-02-02T00:00:00.000Z',
                attributes: {}
            },
            {
                id: 'iptv_series_query_match',
                type: 'series',
                name: 'Shared Query Series',
                category: 'Archive Series',
                addedAt: '2025-02-01T00:00:00.000Z',
                attributes: {}
            }
        ];
        addonInstance.epgData = {};
    };

    const config = {
        provider: 'direct',
        m3uUrl: 'http://example.com/search-compatibility.m3u',
        includeSeries: true,
        homeCategoryCatalogLimit: 1,
        enableEpg: false,
        debug: false
    };

    const iface = await createAddon(config);
    const movieCatalog = iface.manifest.catalogs.find(c => c.id === 'iptv_movies');
    const seriesCatalog = iface.manifest.catalogs.find(c => c.id === 'iptv_series');
    const movieSearchCatalog = iface.manifest.catalogs.find(c => c.id === 'iptv_movies_search');
    const seriesSearchCatalog = iface.manifest.catalogs.find(c => c.id === 'iptv_series_search');
    const tvSearchCatalog = iface.manifest.catalogs.find(c => c.id === 'iptv_channels_search');
    const dynamicMovieCatalogs = iface.manifest.catalogs.filter(c => c.type === 'movie' && c.id.startsWith('iptv_movie_group_'));
    const dynamicSeriesCatalogs = iface.manifest.catalogs.filter(c => c.type === 'series' && c.id.startsWith('iptv_series_group_'));
    const newestMovieCatalog = dynamicMovieCatalogs[0];
    const newestSeriesCatalog = dynamicSeriesCatalogs[0];

    assert.ok(movieCatalog, 'base movie browse catalog should exist');
    assert.ok(seriesCatalog, 'base series browse catalog should exist');
    assert.strictEqual(movieCatalog.name, 'IPTV Movies');
    assert.strictEqual(seriesCatalog.name, 'IPTV Series');
    assert.ok(newestMovieCatalog, 'dynamic movie catalog should exist');
    assert.ok(newestSeriesCatalog, 'dynamic series catalog should exist');
    assert.deepStrictEqual(
        movieCatalog.extra.map(item => ({ name: item.name, isRequired: item.isRequired })),
        [
            { name: 'genre', isRequired: undefined },
            { name: 'skip', isRequired: undefined }
        ]
    );
    assert.deepStrictEqual(movieCatalog.extraSupported, ['genre', 'skip']);
    assert.deepStrictEqual(movieCatalog.extraRequired, []);
    assert.deepStrictEqual(movieCatalog.extra.find(item => item.name === 'genre').options, ['All Movies', 'Archive Movies', 'Movies']);
    assert.deepStrictEqual(
        seriesCatalog.extra.map(item => ({ name: item.name, isRequired: item.isRequired })),
        [
            { name: 'genre', isRequired: undefined },
            { name: 'skip', isRequired: undefined }
        ]
    );
    assert.deepStrictEqual(seriesCatalog.extraSupported, ['genre', 'skip']);
    assert.deepStrictEqual(seriesCatalog.extraRequired, []);
    assert.deepStrictEqual(seriesCatalog.extra.find(item => item.name === 'genre').options, ['All Series', 'Archive Series', 'Series']);
    assert.deepStrictEqual(movieCatalog.genres, ['All Movies', 'Archive Movies', 'Movies']);
    assert.deepStrictEqual(seriesCatalog.genres, ['All Series', 'Archive Series', 'Series']);
    assert.strictEqual(newestMovieCatalog.name, 'Movies');
    assert.strictEqual(newestSeriesCatalog.name, 'Series');
    assert.strictEqual(tvSearchCatalog, undefined, 'tv search-only catalog should not exist');
    assert.ok(movieSearchCatalog, 'movie search-only catalog should exist');
    assert.strictEqual(seriesSearchCatalog, undefined, 'series search-only catalog should not exist');
    assert.strictEqual(movieSearchCatalog.name, 'IPTV Search');
    assert.deepStrictEqual(
        movieSearchCatalog.extra.map(item => ({ name: item.name, isRequired: item.isRequired })),
        [{ name: 'search', isRequired: true }]
    );
    assert.deepStrictEqual(movieSearchCatalog.extraSupported, ['search']);
    assert.deepStrictEqual(movieSearchCatalog.extraRequired, ['search']);

    const router = getRouter(iface);
    const movieCatalogResponse = await invokeRouter(router, normalizeSdkResourceUrl(`/catalog/movie/${newestMovieCatalog.id}.json`));
    const seriesCatalogResponse = await invokeRouter(router, normalizeSdkResourceUrl(`/catalog/series/${newestSeriesCatalog.id}.json`));
    assert.strictEqual(movieCatalogResponse.statusCode, 200);
    assert.strictEqual(seriesCatalogResponse.statusCode, 200);
    assert.deepStrictEqual(
        JSON.parse(movieCatalogResponse.body).metas.map(meta => meta.name),
        ['Search Target', 'Different Movie']
    );
    assert.deepStrictEqual(
        JSON.parse(seriesCatalogResponse.body).metas.map(meta => meta.name),
        ['Search Target', 'Another Show']
    );

    const searchUrls = [
        '/catalog/all/iptv_movies_search.json?search=search%20target&skip=0',
        '/catalog/all/iptv_movies_search.json?search=shared%20query&skip=0',
        '/catalog/movie/iptv_movies.json?search=search%20target&skip=0',
        '/catalog/series/iptv_series.json?search=search%20target&skip=0'
    ];

    const expectedResultsByUrl = new Map([
        ['/catalog/all/iptv_movies_search.json?search=search%20target&skip=0', [{ type: 'movie', name: 'Search Target (Movie)' }, { type: 'series', name: 'Search Target (Series)' }]],
        ['/catalog/all/iptv_movies_search.json?search=shared%20query&skip=0', [{ type: 'movie', name: 'Shared Query Movie (Movie)' }, { type: 'series', name: 'Shared Query Series (Series)' }]],
        ['/catalog/movie/iptv_movies.json?search=search%20target&skip=0', [{ type: 'movie', name: 'Search Target' }]],
        ['/catalog/series/iptv_series.json?search=search%20target&skip=0', [{ type: 'series', name: 'Search Target' }]]
    ]);

    for (const url of searchUrls) {
        const response = await invokeRouter(router, normalizeSdkResourceUrl(url));
        assert.strictEqual(response.statusCode, 200);
        const body = JSON.parse(response.body);
        assert.deepStrictEqual(
            body.metas.map(meta => ({ type: meta.type, name: meta.name })),
            expectedResultsByUrl.get(url)
        );
    }

    directProvider.fetchData = originalFetchData;
}

async function runMetaSanitizationTests() {
    process.env.CACHE_ENABLED = 'true';

    const directProvider = require('../src/js/providers/directProvider');
    const createAddon = require('../addon');

    const originalFetchData = directProvider.fetchData;

    directProvider.fetchData = async (addonInstance) => {
        addonInstance.channels = [];
        addonInstance.movies = [
            {
                id: 'iptv_vod_secure_test',
                type: 'movie',
                name: 'Secure Poster Test',
                poster: 'http://images.vega-xt-mh.com:80/images/poster_big.jpg',
                year: null,
                attributes: {}
            }
        ];
        addonInstance.series = [];
        addonInstance.epgData = {};
    };

    const iface = await createAddon({
        provider: 'direct',
        m3uUrl: 'http://example.com/meta-sanitization.m3u',
        includeSeries: false,
        enableEpg: false,
        debug: false
    });

    const catalog = await iface.get('catalog', 'movie', 'iptv_movies', {}, {});
    const meta = await iface.get('meta', 'movie', 'iptv_vod_secure_test', {}, {});

    assert.strictEqual(catalog.metas[0].poster, 'https://images.vega-xt-mh.com/images/poster_big.jpg');
    assert.strictEqual('year' in catalog.metas[0], false);
    assert.strictEqual(meta.meta.poster, 'https://images.vega-xt-mh.com/images/poster_big.jpg');
    assert.strictEqual('year' in meta.meta, false);

    directProvider.fetchData = originalFetchData;
}

async function runHomeCategoryLimitConfigTests() {
    process.env.CACHE_ENABLED = 'true';

    const directProvider = require('../src/js/providers/directProvider');
    const createAddon = require('../addon');

    const originalFetchData = directProvider.fetchData;

    directProvider.fetchData = async (addonInstance) => {
        addonInstance.channels = [];
        addonInstance.movies = [
            { id: 'm1', type: 'movie', name: 'Newest Movie', category: 'Latest Movies', addedAt: '2026-01-03T00:00:00.000Z', attributes: {} },
            { id: 'm2', type: 'movie', name: 'Older Movie', category: 'Archive Movies', addedAt: '2025-01-03T00:00:00.000Z', attributes: {} }
        ];
        addonInstance.series = [
            { id: 's1', type: 'series', name: 'Newest Series', category: 'Latest Series', addedAt: '2026-02-03T00:00:00.000Z', attributes: {} },
            { id: 's2', type: 'series', name: 'Older Series', category: 'Archive Series', addedAt: '2025-02-03T00:00:00.000Z', attributes: {} }
        ];
        addonInstance.epgData = {};
    };

    const ifaceLimited = await createAddon({
        provider: 'direct',
        m3uUrl: 'http://example.com/home-limit-limited.m3u',
        includeSeries: true,
        enableEpg: false,
        homeCategoryCatalogLimit: 1,
        debug: false
    });

    assert.deepStrictEqual(
        ifaceLimited.manifest.catalogs.filter(c => c.type === 'movie' && c.id.startsWith('iptv_movie_group_')).map(c => c.name),
        ['Latest Movies']
    );
    assert.deepStrictEqual(
        ifaceLimited.manifest.catalogs.filter(c => c.type === 'series' && c.id.startsWith('iptv_series_group_')).map(c => c.name),
        ['Latest Series']
    );

    const ifaceDisabled = await createAddon({
        provider: 'direct',
        m3uUrl: 'http://example.com/home-limit-disabled.m3u',
        includeSeries: true,
        enableEpg: false,
        homeCategoryCatalogLimit: 0,
        debug: false
    });

    assert.deepStrictEqual(
        ifaceDisabled.manifest.catalogs.filter(c => c.id.startsWith('iptv_movie_group_')),
        []
    );
    assert.deepStrictEqual(
        ifaceDisabled.manifest.catalogs.filter(c => c.id.startsWith('iptv_series_group_')),
        []
    );

    directProvider.fetchData = originalFetchData;
}

async function runArabicNormalizationSearchTests() {
    process.env.CACHE_ENABLED = 'true';

    const directProvider = require('../src/js/providers/directProvider');
    const createAddon = require('../addon');

    const originalFetchData = directProvider.fetchData;

    directProvider.fetchData = async (addonInstance) => {
        addonInstance.channels = [];
        addonInstance.movies = [
            {
                id: 'iptv_vod_arabic_digits',
                type: 'movie',
                name: 'ولاد رزق ٣',
                poster: 'https://example.com/rizk3.jpg',
                plot: 'Movie title should match even when digits differ.',
                attributes: {}
            },
            {
                id: 'iptv_vod_plot_noise',
                type: 'movie',
                name: 'Noise Result',
                plot: 'ولاد رزق ٣ موجود فقط في الوصف',
                attributes: {}
            }
        ];
        addonInstance.series = [
            {
                id: 'iptv_series_hamza',
                type: 'series',
                name: 'رؤية ثانية',
                poster: 'https://example.com/vision.jpg',
                category: 'Series',
                attributes: {}
            },
            {
                id: 'iptv_series_noise',
                type: 'series',
                name: 'القروية الجميلة',
                poster: 'https://example.com/noise.jpg',
                category: 'Series',
                attributes: {}
            },
            {
                id: 'iptv_series_typo',
                type: 'series',
                name: 'زهايمر',
                poster: 'https://example.com/alzheimer.jpg',
                category: 'Series',
                attributes: {}
            }
        ];
        addonInstance.epgData = {};
    };

    const iface = await createAddon({
        provider: 'direct',
        m3uUrl: 'http://example.com/arabic-normalization.m3u',
        includeSeries: true,
        enableEpg: false,
        debug: false
    });

    const digitQuery = await iface.get('catalog', 'movie', 'iptv_movies', { search: 'ولاد رزق3', skip: 0 }, {});
    const easternDigitQuery = await iface.get('catalog', 'movie', 'iptv_movies', { search: 'ولاد رزق 3', skip: 0 }, {});
    const hamzaQuery = await iface.get('catalog', 'series', 'iptv_series', { search: 'رويه ثانيه', skip: 0 }, {});
    const singleTokenHamzaQuery = await iface.get('catalog', 'series', 'iptv_series', { search: 'رويه', skip: 0 }, {});
    const typoQuery = await iface.get('catalog', 'series', 'iptv_series', { search: 'زهاير', skip: 0 }, {});

    assert.deepStrictEqual(digitQuery.metas.map(meta => meta.name), ['ولاد رزق ٣']);
    assert.deepStrictEqual(easternDigitQuery.metas.map(meta => meta.name), ['ولاد رزق ٣']);
    assert.deepStrictEqual(hamzaQuery.metas.map(meta => meta.name), ['رؤية ثانية']);
    assert.deepStrictEqual(singleTokenHamzaQuery.metas.map(meta => meta.name), ['رؤية ثانية']);
    assert.deepStrictEqual(typoQuery.metas.map(meta => meta.name), ['زهايمر']);

    directProvider.fetchData = originalFetchData;
}

function runSnapshotNormalizerTests() {
    const {
        fingerprintMediaItem,
        normalizeSeriesInfoEntry,
        normalizeSnapshot
    } = require('../snapshotNormalizer');

    const normalized = normalizeSnapshot({
        xtreamUrl: 'http://panel.example.com:8080',
        xtreamUsername: 'demo',
        xtreamPassword: 'secret',
        includeSeries: true,
        liveCategories: { '10': 'News' },
        vodCategories: { '20': 'Movies' },
        seriesCategories: { '30': 'Series' },
        liveStreams: [
            { stream_id: 1, name: 'Channel 1', category_id: '10', stream_icon: 'https://img/channel.png', epg_channel_id: 'channel-1' }
        ],
        vodStreams: [
            { stream_id: 2, name: 'Movie 1', category_id: '20', stream_icon: 'https://img/movie.png', container_extension: 'mp4', plot: 'Plot', added: '1710000000' }
        ],
        seriesList: [
            { series_id: 3, name: 'Series 1', category_id: '30', cover: 'https://img/series.png', plot: 'Series plot', last_modified: '1710000000' }
        ],
        epgXmlText: [
            '<tv>',
            '<channel id="channel-1"><display-name>Channel 1</display-name></channel>',
            '<programme channel="channel-1" start="20260407070000 +0000" stop="20260407080000 +0000">',
            '<title>Morning Show</title>',
            '<desc>Wake up.</desc>',
            '</programme>',
            '</tv>'
        ].join('')
    });

    assert.strictEqual(normalized.stats.liveCount, 1);
    assert.strictEqual(normalized.stats.vodCount, 1);
    assert.strictEqual(normalized.stats.seriesCount, 1);
    assert.strictEqual(normalized.stats.epgChannels, 1);
    assert.strictEqual(normalized.stats.epgProgrammes, 1);
    assert.strictEqual(normalized.snapshotData.channels[0].url, 'http://panel.example.com:8080/live/demo/secret/1.m3u8');
    assert.strictEqual(normalized.snapshotData.movies[0].url, 'http://panel.example.com:8080/movie/demo/secret/2.mp4');
    assert.strictEqual(normalized.snapshotData.epgData['channel-1'][0].title, 'Morning Show');

    const seriesInfo = normalizeSeriesInfoEntry({
        xtreamUrl: 'http://panel.example.com:8080',
        xtreamUsername: 'demo',
        xtreamPassword: 'secret',
        seriesId: 3,
        fallbackSeries: normalized.snapshotData.series[0],
        infoJson: {
            info: {
                plot: 'Series plot',
                cover: 'https://img/series.png',
                backdrop_path: ['https://img/backdrop.jpg'],
                releaseDate: '2024-03-01'
            },
            episodes: {
                '1': [
                    {
                        id: 33,
                        episode_num: 1,
                        title: 'Episode 1',
                        container_extension: 'mkv',
                        season: 1,
                        added: '1710000000',
                        info: {
                            movie_image: 'https://img/ep1.jpg'
                        }
                    }
                ]
            }
        }
    });

    assert.strictEqual(seriesInfo.videos.length, 1);
    assert.strictEqual(seriesInfo.videos[0].id, 'iptv_series_ep_33');
    assert.strictEqual(seriesInfo.videos[0].url, 'http://panel.example.com:8080/series/demo/secret/33.mkv');
    assert.strictEqual(seriesInfo.videos[0].season, 1);
    assert.strictEqual(seriesInfo.videos[0].episode, 1);
    assert.strictEqual('stream_id' in seriesInfo.videos[0], false);
    assert.strictEqual('series_id' in seriesInfo.videos[0], false);
    assert.strictEqual(seriesInfo.info.plot, 'Series plot');
    assert.notStrictEqual(
        fingerprintMediaItem(normalized.snapshotData.series[0]),
        fingerprintMediaItem({ ...normalized.snapshotData.series[0], addedAt: '2025-01-01T00:00:00.000Z' })
    );
}

async function runSnapshotCompressionTests() {
    const {
        expandSnapshotData,
        prepareSnapshotDataForTransport,
        SERIES_INFO_INDEX_COMPRESSION
    } = require('../snapshotCompression');

    const source = {
        channels: [{ id: 'iptv_live_1', name: 'Channel', type: 'tv' }],
        movies: [],
        series: [{ id: 'iptv_series_3', series_id: 3, name: 'Series', type: 'series' }],
        epgData: {},
        seriesInfoIndex: {
            '3': {
                videos: [
                    {
                        id: 'iptv_series_ep_33',
                        title: 'Episode 1',
                        season: 1,
                        episode: 1,
                        url: 'http://example.com/series/33.mp4'
                    }
                ],
                info: { plot: 'Snapshot series plot' }
            }
        }
    };

    const prepared = await prepareSnapshotDataForTransport(source);
    assert.strictEqual('seriesInfoIndex' in prepared, false);
    assert.strictEqual(prepared.seriesInfoIndexCompression, SERIES_INFO_INDEX_COMPRESSION);
    assert.strictEqual(typeof prepared.seriesInfoIndexCompressed, 'string');

    const expanded = expandSnapshotData(prepared);
    assert.deepStrictEqual(expanded.seriesInfoIndex, source.seriesInfoIndex);
    assert.deepStrictEqual(expanded.channels, source.channels);
}

async function runSnapshotProviderTests() {
    process.env.CACHE_ENABLED = 'true';

    const snapshotStore = require('../snapshotStore');
    const createAddon = require('../addon');

    const originalGetPrimarySnapshotForAddon = snapshotStore.getPrimarySnapshotForAddon;

    snapshotStore.getPrimarySnapshotForAddon = async () => {
        return {
            id: 'primary-snapshot-id',
            snapshot_data: {
                channels: [
                    {
                        id: 'iptv_live_1',
                        type: 'tv',
                        name: 'Snapshot Channel',
                        url: 'http://example.com/live/1.m3u8',
                        category: 'Live',
                        epg_channel_id: 'snapshot-channel',
                        attributes: {}
                    }
                ],
                movies: [
                    {
                        id: 'iptv_vod_2',
                        type: 'movie',
                        name: 'Snapshot Movie',
                        url: 'http://example.com/movie/2.mp4',
                        poster: 'https://example.com/poster.jpg',
                        attributes: {}
                    }
                ],
                series: [
                    {
                        id: 'iptv_series_3',
                        series_id: 3,
                        type: 'series',
                        name: 'Snapshot Series',
                        poster: 'https://example.com/series.jpg',
                        attributes: {}
                    }
                ],
                epgData: {
                    'snapshot-channel': [
                        { start: '20260407070000 +0000', stop: '20260407080000 +0000', title: 'Now Playing', desc: 'Current show' }
                    ]
                },
                seriesInfoIndex: {
                    '3': {
                        videos: [
                            {
                                id: 'iptv_series_ep_33',
                                title: 'Episode 1',
                                season: 1,
                                episode: 1,
                                released: '2026-04-07T00:00:00.000Z',
                                url: 'http://example.com/series/33.mp4'
                            }
                        ],
                        info: { plot: 'Snapshot series plot' }
                    }
                }
            }
        };
    };

    const iface = await createAddon({
        provider: 'xtream_snapshot',
        accessCode: 'potato',
        includeSeries: true,
        enableEpg: true,
        debug: false
    });

    const catalog = await iface.get('catalog', 'tv', 'iptv_channels', {}, {});
    assert.strictEqual(catalog.metas.length, 1);
    assert.strictEqual(catalog.metas[0].name, 'Snapshot Channel');

    const movieStream = await iface.get('stream', 'movie', 'iptv_vod_2', {}, {});
    assert.strictEqual(movieStream.streams[0].url, 'http://example.com/movie/2.mp4');

    const seriesMeta = await iface.get('meta', 'series', 'iptv_series_3', {}, {});
    assert.strictEqual(seriesMeta.meta.videos.length, 1);
    assert.strictEqual(seriesMeta.meta.videos[0].id, 'iptv_series_ep_33');

    const seriesStream = await iface.get('stream', 'series', 'iptv_series_ep_33', {}, {});
    assert.strictEqual(seriesStream.streams.length, 1);
    assert.strictEqual(seriesStream.streams[0].url, 'http://example.com/series/33.mp4');

    snapshotStore.getPrimarySnapshotForAddon = originalGetPrimarySnapshotForAddon;
}

(async () => {
    runSdkUrlUtilsTests();
    runSnapshotNormalizerTests();
    await runSnapshotCompressionTests();
    await runAddonBuildCacheTests();
    await runSearchCompatibilityTests();
    await runHomeCategoryLimitConfigTests();
    await runMetaSanitizationTests();
    await runArabicNormalizationSearchTests();
    await runSnapshotProviderTests();
    console.log('ok');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
