/**
 * The review samples' AI (ADR-001 D-4, DES-005): called from the browser with the operator's own
 * key, which lives only in the page's memory and is never sent to the console's server. Both
 * services speak the OpenAI chat-completions form; the review policy asks for two (審査基準 2.7).
 */
export interface AiService {
  id: 'openai' | 'deepseek';
  label: string;
  base: string;
  /** Which of the account's models are chat models worth offering. */
  isChatModel: (id: string) => boolean;
  /** The service's name for the reply length limit. */
  lengthParam: 'max_completion_tokens' | 'max_tokens';
}

export const AI_SERVICES: AiService[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    base: 'https://api.openai.com/v1',
    isChatModel: (id) => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|embedding|search|instruct)/.test(id),
    lengthParam: 'max_completion_tokens',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    base: 'https://api.deepseek.com',
    isChatModel: (id) => id.startsWith('deepseek'),
    lengthParam: 'max_tokens',
  },
];

async function call<T>(service: AiService, key: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${service.base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = await res.json().then((b: { error?: { message?: string } }) => b.error?.message, () => undefined);
    throw new Error(`${service.label}: ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

/** Chat models the key can use, newest first where the service says when they were made. */
export async function listModels(service: AiService, key: string): Promise<string[]> {
  const out = await call<{ data: { id: string; created?: number }[] }>(service, key, '/models');
  return out.data
    .filter((m) => service.isChatModel(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => m.id);
}

/** One reply to a sample scene, given the system and user prompts the app would send. */
export async function reply(service: AiService, key: string, model: string, system: string, user: string): Promise<string> {
  const out = await call<{ choices: { message: { content: string | null } }[] }>(service, key, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      [service.lengthParam]: 2000,
    }),
  });
  return out.choices[0]?.message.content?.trim() ?? '';
}
