// TaskAura AI proxy — keeps the Anthropic API key server-side.
// Requires env var ANTHROPIC_API_KEY (set in Vercel: Settings → Environment Variables).
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: { message: 'AI is not configured yet — the site owner needs to set ANTHROPIC_API_KEY.' } });
    return;
  }
  const { messages, system, model } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: { message: 'No messages provided.' } });
    return;
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: ALLOWED_MODELS.includes(model) ? model : ALLOWED_MODELS[0],
        max_tokens: 1024,
        system: String(system || '').slice(0, 30000),
        messages: messages.slice(-20).map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content || '').slice(0, 8000)
        })),
        stream: true
      })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).setHeader('content-type', 'application/json').send(errText);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(502).json({ error: { message: 'Upstream error: ' + e.message } });
    } else {
      res.end();
    }
  }
}
