  const admin = require('firebase-admin');

const MODEL = process.env.NEXUS_MODEL || 'openrouter/free';
const VISION_MODEL =
  process.env.NEXUS_VISION_MODEL || 'google/gemini-2.5-flash';

function initFirebase() {
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    throw new Error('Firebase server configuration is missing.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
  }

  return admin.firestore();
}

function json(res, status, body) {
  res.status(status).json(body);
}

function extractMemories(text) {
  const patterns = [
    /^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i,
    /^(?:please\s+)?keep\s+in\s+mind\s+that\s+(.+)$/i,
    /^my\s+(?:preference|preferences)\s+(?:is|are)\s+(.+)$/i
  ];

  for (const p of patterns) {
    const m = String(text || '').trim().match(p);

    if (m?.[1] && m[1].trim().length >= 3) {
      return m[1].trim().slice(0, 1000);
    }
  }

  return null;
}

async function getMemories(db, uid) {
  try {
    const snap = await db
      .collection('users')
      .doc(uid)
      .collection('memories')
      .orderBy('updatedAt', 'desc')
      .limit(40)
      .get();

    return snap.docs
      .map(d => d.data()?.text)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildSystem(memories) {
  return `You are Nexus AI, a highly capable, careful, intelligent assistant.

Be useful, accurate, concise when appropriate, and explain reasoning clearly without exposing hidden chain-of-thought.

For current, changing, or research questions, use web search when it is enabled.

When sources are available, cite them with markdown links.

If you are unsure, say so instead of inventing facts.

You can analyze uploaded images, read text in images, help with code, calculations, writing, planning, research, and creative work.

The user may explicitly ask you to remember something; those explicit memories are provided below and should be used naturally.

Long-term memories:
${
  memories.length
    ? memories.map(x => '- ' + x).join('\n')
    : '(none saved)'
}`;
}

function shouldResearch(text) {
  return /\b(latest|today|current|recent|news|research|look\s*up|search|find\s+out|verify|sources?|price|prices|weather|market|2026|this\s+week|this\s+month)\b/i.test(
    text || ''
  );
}

async function callOpenRouter({
  messages,
  research,
  model = MODEL
}) {
  const body = {
    model,
    messages,
    temperature: 0.2
  };

  if (research) {
    body.plugins = [
      {
        id: 'web',
        max_results: 5
      }
    ];
  }

  const r = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer':
          process.env.APP_URL ||
          'https://nexus-deepseek.vercel.app',
        'X-Title': 'Nexus AI'
      },
      body: JSON.stringify(body)
    }
  );

  const raw = await r.text();

  let data = {};

  try {
    data = JSON.parse(raw);
  } catch {}

  if (!r.ok) {
    throw new Error(
      data?.error?.message ||
        `OpenRouter returned HTTP ${r.status}`
    );
  }

  return data;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, {
      error: 'Method not allowed.'
    });
  }

  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return json(res, 500, {
        error: 'OPENROUTER_API_KEY is missing.'
      });
    }

    const db = initFirebase();

    const authHeader =
      req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return json(res, 401, {
        error: 'Authentication required.'
      });
    }

    const token = authHeader.slice(7).trim();

    const decoded =
      await admin.auth().verifyIdToken(token);

    const uid = decoded.uid;

    const message = String(
      req.body?.message || ''
    ).trim();

    const chatId = String(
      req.body?.chatId || ''
    ).trim();

    /*
     * Image support
     *
     * imageData = base64 image data
     * imageMime = image/jpeg, image/png, etc.
     */
    const imageData =
      req.body?.imageData || null;

    const imageMime =
      req.body?.imageMime || 'image/jpeg';

    if (!message && !imageData) {
      return json(res, 400, {
        error: 'Message is empty.'
      });
    }

    const [memories, contextSnap] =
      await Promise.all([
        getMemories(db, uid),

        chatId
          ? db
              .collection('users')
              .doc(uid)
              .collection('chats')
              .doc(chatId)
              .collection('messages')
              .orderBy('createdAt', 'desc')
              .limit(18)
              .get()
          : null
      ]);

    const history = contextSnap
      ? contextSnap.docs
          .reverse()
          .map(d => d.data())
          .filter(
            x =>
              x.role === 'user' ||
              x.role === 'assistant'
          )
      : [];

    /*
     * Build user content.
     */
    const userContent = [];

    if (message) {
      userContent.push({
        type: 'text',
        text: message
      });
    }

    if (imageData) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${imageMime};base64,${imageData}`
        }
      });
    }

    /*
     * Build messages for OpenRouter.
     */
    const messages = [
      {
        role: 'system',
        content: buildSystem(memories)
      },

      ...history.slice(-12).map(x => ({
        role: x.role,
        content: String(
          x.content || ''
        ).slice(0, 12000)
      })),

      {
        role: 'user',
        content: imageData
          ? userContent
          : message
      }
    ];

    /*
     * Automatically enable web research
     * for questions that need current information.
     */
    const research =
      shouldResearch(message);

    /*
     * Use the vision model when an image
     * has been attached.
     */
    const data = await callOpenRouter({
      messages,
      research,
      model: imageData
        ? VISION_MODEL
        : MODEL
    });

    const choice =
      data?.choices?.[0]?.message || {};

    let text = '';

    if (typeof choice.content === 'string') {
      text = choice.content;
    } else if (choice.content?.map) {
      text = choice.content
        .map(x => x.text || '')
        .join('');
    }

    if (!text) {
      text =
        'I could not generate a response.';
    }

    /*
     * Extract web sources when available.
     */
    const annotations =
      choice.annotations || [];

    const sources = annotations
      .map(a => a?.url_citation)
      .filter(Boolean)
      .map(x => ({
        title: x.title,
        url: x.url
      }));

    /*
     * Save explicit memories.
     */
    const memory =
      extractMemories(message);

    if (memory) {
      await db
        .collection('users')
        .doc(uid)
        .collection('memories')
        .add({
          text: memory,
          createdAt:
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        });
    }

    /*
     * Send response back to frontend.
     */
    return json(res, 200, {
      text,

      model:
        data.model ||
        (imageData
          ? VISION_MODEL
          : MODEL),

      sources,

      remembered: !!memory
    });
  } catch (e) {
    console.error(
      'Nexus chat error:',
      e
    );

    return json(res, 500, {
      error:
        e?.message ||
        'Nexus AI is temporarily unavailable.'
    });
  }
};
