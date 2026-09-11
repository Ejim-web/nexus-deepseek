const admin = require('firebase-admin');

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
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed.'
    });
  }

  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: 'OPENROUTER_API_KEY is missing.'
      });
    }

    initFirebase();

    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    await admin
      .auth()
      .verifyIdToken(authHeader.slice(7).trim());

    const prompt = String(
      req.body?.prompt || ''
    ).trim();

    if (!prompt) {
      return res.status(400).json({
        error: 'Image prompt is empty.'
      });
    }

    const body = {
      model:
        process.env.NEXUS_IMAGE_MODEL ||
        'openai/gpt-5-image',

      prompt,

      size:
        req.body?.size ||
        '1024x1024',

      quality:
        req.body?.quality ||
        'medium',

      n: 1
    };

    const response = await fetch(
      'https://openrouter.ai/api/v1/images',
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${process.env.OPENROUTER_API_KEY}`,

          'Content-Type':
            'application/json',

          'HTTP-Referer':
            process.env.APP_URL ||
            'https://nexus-deepseek.vercel.app',

          'X-Title':
            'Nexus AI'
        },

        body: JSON.stringify(body)
      }
    );

    const raw = await response.text();

    let data = {};

    try {
      data = JSON.parse(raw);
    } catch {}

    if (!response.ok) {
      const message =
        data?.error?.message ||
        `Image generation is currently unavailable (HTTP ${response.status}).`;

      const lower =
        String(message).toLowerCase();

      const noCredits =
        response.status === 402 ||
        lower.includes('credit') ||
        lower.includes('insufficient') ||
        lower.includes('payment') ||
        lower.includes('balance') ||
        lower.includes('quota');

      if (noCredits) {
        return res.status(200).json({
          available: false,
          error:
            'Image generation is currently unavailable because no image credits are available. You can still use Nexus AI for chat, research, coding, writing, calculations, and image analysis.'
        });
      }

      throw new Error(message);
    }

    const item =
      data?.data?.[0];

    if (!item?.b64_json) {
      return res.status(200).json({
        available: false,
        error:
          'Image generation is currently unavailable right now. You can still use Nexus AI for chat, research, coding, writing, calculations, and image analysis.'
      });
    }

    return res.status(200).json({
      available: true,

      image:
        `data:${item.media_type || 'image/png'};base64,${item.b64_json}`,

      model:
        data.model ||
        body.model
    });

  } catch (error) {
    console.error(
      'Nexus image error:',
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        'Image generation failed.'
    });
  }
};
