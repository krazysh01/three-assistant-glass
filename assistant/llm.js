// Streams a chat completion from an OpenAI-compatible /chat/completions
// endpoint. The request goes straight from the browser to the endpoint, so the
// server never sees the conversation or the key - see the CORS note in README.

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

export async function streamChat(messages, settings, { signal, onDelta } = {}) {
  const baseUrl = (settings.customLLMBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.customLLMApiKey) headers.Authorization = `Bearer ${settings.customLLMApiKey}`;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.customLLMModel || '',
      messages,
      stream: true,
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`LLM request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    // SSE frames can be split across network chunks - only parse complete lines
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      } catch {
        // ignore keep-alive / malformed frames
      }
    }
  }
  return full;
}
