const { fetch } = require('undici');
const TavilySearchResults = require('../TavilySearchResults');
const { getEnvProxyDispatcher } = require('@librechat/api');

jest.mock('undici');
jest.mock('@librechat/api', () => ({
  getEnvProxyDispatcher: jest.fn(),
}));

describe('TavilySearchResults', () => {
  let originalEnv;
  const mockApiKey = 'mock_api_key';

  beforeAll(() => {
    originalEnv = { ...process.env };
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: mockApiKey,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw an error if TAVILY_API_KEY is missing', () => {
    delete process.env.TAVILY_API_KEY;
    expect(() => new TavilySearchResults()).toThrow('Missing TAVILY_API_KEY environment variable.');
  });

  it('should use mockApiKey when TAVILY_API_KEY is not set in the environment', () => {
    const instance = new TavilySearchResults({
      TAVILY_API_KEY: mockApiKey,
    });
    expect(instance.apiKey).toBe(mockApiKey);
  });

  /* Sweep 0.8 (Nov 13 2026): raw answers are cut per result before they reach the prompt. */
  describe('result size cap', () => {
    const long = 'x'.repeat(20000);
    const answer = () => ({
      ok: true,
      json: jest.fn().mockResolvedValue({
        answer: 'short',
        results: [
          { url: 'https://a.example', title: 'A', content: long, raw_content: long },
          { url: 'https://b.example', title: 'B', content: 'small', raw_content: null },
        ],
      }),
    });

    it('cuts content and raw_content to 6000 characters by default and leaves the rest alone', async () => {
      fetch.mockResolvedValue(answer());
      const instance = new TavilySearchResults({ TAVILY_API_KEY: mockApiKey });
      const out = JSON.parse(await instance._call({ query: 'q', include_raw_content: true }));
      expect(out.answer).toBe('short');
      expect(out.results[0].content).toBe(`${'x'.repeat(6000)} [cut at 6000 characters]`);
      expect(out.results[0].raw_content).toBe(`${'x'.repeat(6000)} [cut at 6000 characters]`);
      expect(out.results[0].url).toBe('https://a.example');
      expect(out.results[1]).toEqual({
        url: 'https://b.example',
        title: 'B',
        content: 'small',
        raw_content: null,
      });
    });

    it('KADE_TAVILY_RESULT_MAX_CHARS sets the cut; 0 returns the answer whole, as before', async () => {
      process.env.KADE_TAVILY_RESULT_MAX_CHARS = '100';
      fetch.mockResolvedValue(answer());
      const instance = new TavilySearchResults({ TAVILY_API_KEY: mockApiKey });
      let out = JSON.parse(await instance._call({ query: 'q' }));
      expect(out.results[0].raw_content.startsWith('x'.repeat(100) + ' [cut')).toBe(true);
      process.env.KADE_TAVILY_RESULT_MAX_CHARS = '0';
      fetch.mockResolvedValue(answer());
      out = JSON.parse(await instance._call({ query: 'q' }));
      expect(out.results[0].raw_content).toHaveLength(20000);
      expect(TavilySearchResults.tavilyResultMaxChars({ KADE_TAVILY_RESULT_MAX_CHARS: 'lots' })).toBe(6000);
      expect(TavilySearchResults.capTavilyResults({ error: 'x' })).toEqual({ error: 'x' });
    });
  });

  describe('proxy support', () => {
    const mockResponse = {
      ok: true,
      json: jest.fn().mockResolvedValue({ results: [] }),
    };

    beforeEach(() => {
      fetch.mockResolvedValue(mockResponse);
    });

    it('should use a shared proxy dispatcher when configured', async () => {
      const mockProxyDispatcher = { type: 'proxy-dispatcher' };
      getEnvProxyDispatcher.mockReturnValue(mockProxyDispatcher);

      const instance = new TavilySearchResults({ TAVILY_API_KEY: mockApiKey });
      await instance._call({ query: 'test query' });

      expect(getEnvProxyDispatcher).toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith(
        'https://api.tavily.com/search',
        expect.objectContaining({
          dispatcher: mockProxyDispatcher,
        }),
      );
    });

    it('should not attach a dispatcher when no proxy is configured', async () => {
      getEnvProxyDispatcher.mockReturnValue(undefined);

      const instance = new TavilySearchResults({ TAVILY_API_KEY: mockApiKey });
      await instance._call({ query: 'test query' });

      expect(getEnvProxyDispatcher).toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith(
        'https://api.tavily.com/search',
        expect.not.objectContaining({
          dispatcher: expect.anything(),
        }),
      );
    });
  });
});
