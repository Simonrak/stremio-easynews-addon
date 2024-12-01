import { createBasic } from './utils';
import { EasynewsSearchResponse, FileData, SearchOptions } from './types';

export class EasynewsAPI {
  private readonly baseUrl = 'https://members.easynews.com';
  private readonly headers: Headers;
  private agent: any;
  private readonly timeout: number;
  private readonly userAgent: string;

  constructor(options: { username: string; password: string }) {
    if (!options) {
      throw new Error('Missing options');
    }

    console.log('Initializing EasynewsAPI', { username: options.username });

    this.headers = new Headers();
    const basic = createBasic(options.username, options.password);
    this.headers.append('Authorization', basic);
    this.timeout = parseInt(process.env.API_TIMEOUT || '20000');
    this.userAgent = process.env.API_USER_AGENT || 'curl/7.64.0';
    this.headers.append('User-Agent', this.userAgent);

    if (process.env.PROXY_ENABLED === 'true') {
      this.initializeProxy();
    } else {
      this.agent = null;
    }

    console.log('API initialization complete');
  }

  private initializeProxy() {
    try {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      const proxyUrl = `socks5://${process.env.PROXY_URL || 'warp'}:${process.env.PROXY_PORT || '1085'}`;
      console.log('Initializing proxy with URL', { proxyUrl });

      this.agent = new SocksProxyAgent(proxyUrl);
      console.log('Successfully initialized proxy agent');
    } catch (error) {
      console.error('Failed to initialize proxy agent', error);
      this.agent = null;
    }
  }

  private async fetch(url: string, options: RequestInit = {}) {
    const headers = new Headers(this.headers);
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        headers.append(key, value);
      }
    }

    const fetchOptions: RequestInit & { agent?: any } = {
      ...options,
      headers,
    };

    if (process.env.PROXY_ENABLED === 'true') {
      if (!this.agent) {
        // Try to initialize proxy again
        this.initializeProxy();
      }

      if (!this.agent) {
        console.error('Proxy required but not available - request blocked');
        throw new Error('Proxy required but not available');
      }

      fetchOptions.agent = this.agent;
      console.log('Using proxy for request');
    }

    try {
      return await fetch(url, fetchOptions);
    } catch (error) {
      // If fetch fails with proxy, try to reinitialize for next time
      if (process.env.PROXY_ENABLED === 'true') {
        this.agent = null;
      }
      console.error('Fetch request failed', { error, url });
      throw error;
    }
  }

  async search({
    query,
    pageNr = 1,
    maxResults = 1000,
    sort1 = 'dsize',
    sort1Direction = '-',
    sort2 = 'relevance',
    sort2Direction = '-',
    sort3 = 'dtime',
    sort3Direction = '-',
  }: SearchOptions): Promise<EasynewsSearchResponse> {
    const searchParams = {
      st: 'adv',
      sb: '1',
      fex: 'm4v,3gp,mov,divx,xvid,wmv,avi,mpg,mpeg,mp4,mkv,avc,flv,webm',
      'fty[]': 'VIDEO',
      spamf: '1',
      u: '1',
      gx: '1',
      pno: pageNr.toString(),
      sS: '3',
      s1: sort1,
      s1d: sort1Direction,
      s2: sort2,
      s2d: sort2Direction,
      s3: sort3,
      s3d: sort3Direction,
      pby: maxResults.toString(),
      safeO: '0',
      gps: query,
    };

    const url = new URL(`${this.baseUrl}/2.0/search/solr-search/advanced`);
    url.search = new URLSearchParams(searchParams).toString();

    console.log('Starting search request', {
      url: url.toString(),
      params: searchParams,
    });

    const fetchOptions: any = {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout), // Use environment variable for timeout
    };

    const res = await this.fetch(url.toString(), fetchOptions);

    if (!res.ok) {
      const error = `Failed to fetch search results of query '${query}': ${res.status} ${res.statusText}`;
      console.error(error);
      throw new Error(error);
    }

    const json = await res.json();
    console.log('Successfully searched Easynews', {
      query,
      results: json.data?.length ?? 0,
    });

    return json;
  }

  async searchAll(options: SearchOptions): Promise<EasynewsSearchResponse> {
    console.log('Starting searchAll request through proxy');

    const data: FileData[] = [];
    let res: EasynewsSearchResponse;
    let pageNr = 1;

    while (true) {
      res = await this.search({ ...options, pageNr });

      // No more results.
      if (
        (res.data ?? []).length === 0 ||
        data[0]?.['0'] === res.data[0]?.['0']
      ) {
        break;
      }

      data.push(...res.data);
      console.log(`Fetched page ${pageNr}, total results: ${data.length}`);

      pageNr++;
    }

    res.data = data;
    console.log('SearchAll complete', { totalResults: data.length });

    return res;
  }
}
