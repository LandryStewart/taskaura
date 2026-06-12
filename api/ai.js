// TaskAura AI proxy — keeps the Anthropic API key server-side.
// Requires env var ANTHROPIC_API_KEY (set in Vercel: Settings → Environment Variables).
// Every request must carry a valid Supabase sign-in token from an approved Team-plan user.
const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
const SUPABASE_URL = 'https://kxidfwesywhhdifekkqo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Mpf3fQxq5253lluxVGdXxA_Se4rBp9z';
const ADMIN_EMAIL = 'landrystewart@live.com';

async function verifyCaller(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return { ok: false, status: 401, msg: 'Please sign in to use the AI assistant.' };

  // 1) Is this a real, signed-in TaskAura user?
  const uResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SUPABASE_KEY, authorization: 'Bearer ' + token }
  });
  if (!uResp.ok) return { ok: false, status: 401, msg: 'Your session has expired — please sign in again.' };
  const user = await uResp.json();
  if (!user || !user.id) return { ok: false, status: 401, msg: 'Your session has expired — please sign in again.' };

  // Admin always allowed
  if ((user.email || '').toLowerCase() === ADMIN_EMAIL) return { ok: true };

  // 2) Is the user approved and on the Team plan?
  const pResp = await fetch(
    SUPABASE_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id) + '&select=plan,approved',
    { headers: { apikey: SUPABASE_KEY, authorization: 'Bearer ' + token } }
  );
  if (!pResp.ok) return { ok: false, status: 403, msg: 'Could not verify your account.' };
  const rows = await pResp.json();
  const profile = Array.isArray(rows) ? rows[0] : null;
  if (!profile || profile.approved === false) {
    return { ok: false, status: 403, msg: 'Your account is awaiting approval.' };
  }
  if (profile.plan !== 'team') {
    return { ok: false, status: 403, msg: '🔒 The AI assistant is a Team plan feature.' };
  }
  return { ok: true };
}

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

  // Auth gate — nobody reaches Anthropic without a valid Team-plan session
  let gate;
  try {
    gate = await verifyCaller(req);
  } catch (e) {
    res.status(502).json({ error: { message: 'Could not verify your account: ' + e.message } });
    return;
  }
  if (!gate.ok) {
    res.status(gate.status).json({ error: { message: gate.msg } });
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
