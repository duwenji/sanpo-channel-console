import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_SERVICES, listModels, reply } from '../src/ai';

const [openai, deepseek] = AI_SERVICES as [(typeof AI_SERVICES)[0], (typeof AI_SERVICES)[0]];

function respond(body: unknown, status = 200) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('the review samples’ AI services', () => {
  it('sends each service its own endpoint, key and length parameter', async () => {
    for (const [service, url, param] of [
      [openai, 'https://api.openai.com/v1/chat/completions', 'max_completion_tokens'],
      [deepseek, 'https://api.deepseek.com/chat/completions', 'max_tokens'],
    ] as const) {
      const fetch = respond({ choices: [{ message: { content: ' こんにちは。 ' } }] });
      expect(await reply(service, 'sk-test', 'model-x', 'system prompt', 'user prompt')).toBe('こんにちは。');
      const [called, init] = fetch.mock.calls[0]!;
      expect(called).toBe(url);
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
      const body = JSON.parse(String(init!.body));
      expect(body).toMatchObject({ model: 'model-x', messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'user prompt' }] });
      expect(body[param]).toBe(2000);
    }
  });

  it('offers only chat models', async () => {
    respond({ data: [{ id: 'gpt-x', created: 2 }, { id: 'text-embedding-3', created: 3 }, { id: 'gpt-x-audio', created: 4 }, { id: 'gpt-old', created: 1 }] });
    expect(await listModels(openai, 'k')).toEqual(['gpt-x', 'gpt-old']);
    respond({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
    expect(await listModels(deepseek, 'k')).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('says which service refused, and why', async () => {
    respond({ error: { message: 'Incorrect API key provided' } }, 401);
    await expect(reply(deepseek, 'bad', 'm', 's', 'u')).rejects.toThrow('DeepSeek: 401 Incorrect API key provided');
  });
});
