import {
  Cache,
  ContentType,
  MetaDetail,
  MetaVideo,
  Stream,
} from 'stremio-addon-sdk';
import addonBuilder from 'stremio-addon-sdk/src/builder';
import landingTemplate from 'stremio-addon-sdk/src/landingTemplate';
import { catalog, manifest } from './manifest';
import {
  buildSearchQuery,
  createStreamPath,
  createStreamUrl,
  createThumbnailUrl,
  getDuration,
  getFileExtension,
  getPostTitle,
  getQuality,
  getSize,
  isBadVideo,
  logError,
  matchesTitle,
} from './utils';
import { EasynewsAPI, SearchOptions, createBasic } from '@easynews/api';
import { publicMetaProvider } from './meta';
import { fromHumanReadable, toDirection } from './sort-option';
import { generateStreamToken } from './proxy';

// Extend the original Config type
interface ExtendedConfig {
  username: string;
  password: string;
  proxyPassword?: string;
  sort1?: string;
  sort1Direction?: string;
  sort2?: string;
  sort2Direction?: string;
  sort3?: string;
  sort3Direction?: string;
}

const builder = new addonBuilder(manifest);

const prefix = `${catalog.id}:`;

builder.defineCatalogHandler(async ({ extra: { search } }) => {
  return {
    metas: [
      {
        id: `${prefix}${encodeURIComponent(search)}`,
        name: search,
        type: 'tv',
        logo: manifest.logo,
        background: manifest.background,
        posterShape: 'square',
        poster: manifest.logo,
        description: `Provides search results from Easynews for '${search}'`,
      },
    ],
    cacheMaxAge: 3600 * 24 * 30, // The returned data is static so it may be cached for a long time (30 days).
  };
});

builder.defineMetaHandler(
  async ({ id, type, config: { username, password } }) => {
    try {
      if (!id.startsWith(catalog.id)) {
        return { meta: null as unknown as MetaDetail };
      }

      const search = decodeURIComponent(id.replace(prefix, ''));

      const videos: MetaVideo[] = [];

      const api = new EasynewsAPI({ username, password });
      const res = await api.searchAll({ query: search });

      for (const file of res?.data ?? []) {
        const title = getPostTitle(file);

        if (isBadVideo(file) || !matchesTitle(title, search, false)) {
          continue;
        }

        videos.push({
          id: `${prefix}${file.sig}`,
          released: new Date(file['5']).toISOString(),
          title,
          overview: file['6'],
          thumbnail: createThumbnailUrl(res, file),
          streams: [
            mapStream({
              username,
              password,
              title,
              fullResolution: file.fullres,
              fileExtension: getFileExtension(file),
              duration: getDuration(file),
              size: getSize(file),
              url: `${createStreamUrl(res)}/${createStreamPath(file)}`,
              videoSize: file.rawSize,
            }),
          ],
        });
      }

      return {
        meta: {
          id,
          name: search,
          type: 'tv',
          logo: manifest.logo,
          background: manifest.background,
          poster: manifest.logo,
          posterShape: 'square',
          description: `Provides search results from Easynews for '${search}'`,
          videos,
        },
        ...getCacheOptions(videos.length),
      };
    } catch (error) {
      logError({
        message: 'failed to handle meta',
        error,
        context: { resource: 'meta', id, type },
      });
      return { meta: null as unknown as MetaDetail };
    }
  }
);

builder.defineStreamHandler(
  async ({
    id,
    type,
    config,
  }: {
    id: string;
    type: ContentType;
    config: ExtendedConfig;
  }) => {
    try {
      if (!id.startsWith('tt')) {
        return { streams: [] };
      }

      let username = config.username;
      let password = config.password;

      if (process.env.PROXY_ENABLED === 'true') {
        const requiredProxyPassword = process.env.PROXY_PASSWORD;
        if (!requiredProxyPassword) {
          throw new Error('Proxy password not configured on server');
        }
        if (config.proxyPassword !== requiredProxyPassword) {
          throw new Error('Invalid proxy password');
        }

        // Use default credentials in proxy mode
        username = process.env.DEFAULT_USERNAME || '';
        password = process.env.DEFAULT_PASSWORD || '';

        if (!username || !password) {
          throw new Error('Default credentials not configured on server');
        }
      }

      const { proxyPassword, ...options } = config;

      // Sort options are profiled as human-readable strings in the manifest.
      // so we need to convert them back to their internal representation
      // before passing them to the search function below.
      const sortOptions: Partial<SearchOptions> = {
        sort1: fromHumanReadable(options.sort1),
        sort2: fromHumanReadable(options.sort2),
        sort3: fromHumanReadable(options.sort3),
        sort1Direction: toDirection(options.sort1Direction),
        sort2Direction: toDirection(options.sort2Direction),
        sort3Direction: toDirection(options.sort3Direction),
      };

      const meta = await publicMetaProvider(id, type);

      const api = new EasynewsAPI({ username, password });

      let query = buildSearchQuery(type, { ...meta, year: undefined });
      let res = await api.search({
        ...sortOptions,
        query,
      });

      if (res?.data?.length <= 1 && meta.year !== undefined) {
        query = buildSearchQuery(type, meta);
        res = await api.search({
          ...sortOptions,
          query,
        });
      }

      if (!res || !res.data) {
        return { streams: [] };
      }

      const streams: Stream[] = [];

      for (const file of res.data ?? []) {
        const title = getPostTitle(file);

        if (isBadVideo(file)) {
          continue;
        }

        // For series there are multiple possible queries that could match the title.
        // We check if at least one of them matches.
        if (type === 'series') {
          const queries = [
            // full query with season and episode (and optionally year)
            query,
            // query with episode only
            buildSearchQuery(type, { name: meta.name, episode: meta.episode }),
          ];

          if (!queries.some((query) => matchesTitle(title, query, false))) {
            continue;
          }
        }

        // Movie titles should match the query strictly.
        // Other content types are loosely matched.
        if (!matchesTitle(title, query, type === 'movie')) {
          continue;
        }

        streams.push(
          mapStream({
            username,
            password,
            fullResolution: file.fullres,
            fileExtension: getFileExtension(file),
            duration: getDuration(file),
            size: getSize(file),
            title,
            url: `${createStreamUrl(res)}/${createStreamPath(file)}`,
            videoSize: file.rawSize,
          })
        );
      }

      return { streams, ...getCacheOptions(streams.length) };
    } catch (error) {
      logError({
        message: 'failed to handle stream',
        error,
        context: { resource: 'stream', id, type },
      });
      return { streams: [] };
    }
  }
);

function mapStream({
  username,
  password,
  duration,
  size,
  fullResolution,
  title,
  fileExtension,
  videoSize,
  url,
}: {
  title: string;
  url: string;
  username: string;
  password: string;
  fileExtension: string;
  videoSize: number | undefined;
  duration: string | undefined;
  size: string | undefined;
  fullResolution: string | undefined;
}): Stream {
  const quality = getQuality(title, fullResolution);

  // When proxy is enabled, generate a secure token for the stream
  let streamUrl = url;
  if (process.env.PROXY_ENABLED === 'true') {
    const token = generateStreamToken(url, username, password);
    const domain = process.env.ADDON_DOMAIN || 'easynews.simon.casino';
    streamUrl = `https://${domain}/${token}/video`;
  }

  return {
    name: `Easynews+${quality ? `\n${quality}` : ''}`,
    description: [
      `${title}${fileExtension}`,
      `🕛 ${duration ?? 'unknown duration'}`,
      `📦 ${size ?? 'unknown size'}`,
    ].join('\n'),
    url: streamUrl,
    behaviorHints: {
      notWebReady: false, // Change to false since we're handling the stream
      proxyHeaders:
        process.env.PROXY_ENABLED !== 'true'
          ? {
              request: {
                'User-Agent': 'Stremio',
                Authorization: createBasic(username, password),
              },
            }
          : undefined,
      fileName: title,
      videoSize,
    } as Stream['behaviorHints'],
  };
}

function getCacheOptions(itemsLength: number): Partial<Cache> {
  if (itemsLength === 0) {
    return {};
  }

  const oneDay = 3600 * 24;
  const oneWeek = oneDay * 7;

  return {
    cacheMaxAge: oneWeek,
    staleError: oneDay,
    staleRevalidate: oneDay,
  };
}

export const addonInterface = builder.getInterface();
export const landingHTML = landingTemplate(addonInterface.manifest);
