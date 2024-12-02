import { Manifest, ManifestCatalog } from 'stremio-addon-sdk';
import {
  DirectionKey,
  humanReadableDirections,
  humanReadableSortOptions,
  toHumanReadable,
} from './sort-option';
const { version, description } = require('../package.json');

export const catalog: ManifestCatalog = {
  id: 'easynews-plus',
  name: 'Easynews+',
  type: 'tv',
  extra: [{ name: 'search', isRequired: true }],
};

// TODO: fix in '@types/stremio-addon-sdk'
const sortOptions = humanReadableSortOptions as any;
const directionOptions = humanReadableDirections as any;

export const manifest: Manifest = {
  id: 'community.easynews-plus',
  version,
  description,
  catalogs: [catalog],
  resources: [
    'catalog',
    { name: 'meta', types: ['tv'], idPrefixes: [catalog.id] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] },
  ],
  types: ['movie', 'series', 'tv'],
  name: 'Easynews+',
  background: 'https://images.pexels.com/photos/518543/pexels-photo-518543.jpeg',
  logo: 'https://pbs.twimg.com/profile_images/479627852757733376/8v9zH7Yo_400x400.jpeg',
  behaviorHints: { configurable: true, configurationRequired: true },
  contactEmail: 'easynews@stremio.com',
  idPrefixes: ['tt'],
  config:
    process.env.PROXY_ENABLED === 'true'
      ? [
          {
            title: 'Proxy Access - Enter Password',
            key: 'proxyPassword',
            type: 'password',
            required: 'true',
          },
        ]
      : [
          { title: 'username', key: 'username', type: 'text' },
          { title: 'password', key: 'password', type: 'password' },
          {
            title: 'Sort 1st',
            key: 'sort1',
            type: 'select',
            options: sortOptions,
            default: toHumanReadable('Size'),
          },
          {
            title: 'Sort 1st direction',
            key: 'sort1Direction',
            type: 'select',
            options: directionOptions,
            default: '-',
          },
          {
            title: 'Sort 2nd',
            key: 'sort2',
            type: 'select',
            options: sortOptions,
            default: toHumanReadable('Relevance'),
          },
          {
            title: 'Sort 2nd direction',
            key: 'sort2Direction',
            type: 'select',
            options: directionOptions,
            default: '-',
          },
          {
            title: 'Sort 3rd',
            key: 'sort3',
            type: 'select',
            options: sortOptions,
            default: toHumanReadable('DateTime'),
          },
          {
            title: 'Sort 3rd direction',
            key: 'sort3Direction',
            type: 'select',
            options: directionOptions,
            default: '-',
          },
        ],
};
