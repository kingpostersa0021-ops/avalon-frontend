/**
 * Avalon AI — Backend Proxy Server
 * Hides your Anthropic API key from the public.
 * Deploy this on Railway. Set ANTHROPIC_API_KEY in Railway's Variables tab.
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Rate limiting (simple in-memory) ────────────────────────────────────────
const rateLimits = new Map();
const RATE_LIMIT = 30;        // max requests per IP
const RATE_WINDOW = 60 * 1000; // per 60 seconds

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const record = rateLimits.get(ip) || { count: 0, start: now };

  if (now - record.start > RATE_WINDOW) {
    record.count = 1;
    record.start = now;
  } else {
    record.count++;
  }

  rateLimits.set(ip, record);

  if (record.count > RATE_LIMIT) {
    return res.status(429).json({
      error: { message: 'Too many requests — please slow down and try again shortly.' }
    });
  }
  next();
}

// ─── CORS — update this to your actual Vercel/domain URL ─────────────────────
const allowedOrigins = [
  'https://YOUR-SITE.vercel.app',   // ← replace with your Vercel URL
  'https://yourdomain.co.za',        // ← replace with your custom domain (if any)
  'http://localhost:5500',           // for local testing
  'http://127.0.0.1:5500',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json({ limit: '2mb' })); // limit body size

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Avalon AI backend is running ✅' });
});

// ─── Main chat proxy endpoint ─────────────────────────────────────────────────
app.post('/chat', rateLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: { message: 'Server misconfiguration — API key not set.' }
    });
  }

  // Basic validation
  const { messages, model, max_tokens } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'Invalid request — messages array required.' } });
  }

  try {
    const isStreaming = req.body.stream === true;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        ...req.body,
        // Enforce safe defaults
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: Math.min(max_tokens || 2048, 4096), // cap at 4096
      }),
    });

    // Stream the response back to the browser
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      anthropicRes.body.pipeTo(new WritableStream({
        write(chunk) { res.write(chunk); },
        close() { res.end(); },
        abort(err) { console.error('Stream error:', err); res.end(); }
      }));
    } else {
      // Non-streaming (paraphrase tool uses this)
      const data = await anthropicRes.json();
      res.status(anthropicRes.status).json(data);
    }

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: { message: 'Proxy server error: ' + err.message } });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Avalon AI proxy running on port ${PORT}`);
});
