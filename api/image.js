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

    const token = authHeader.slice(7).trim();

    await admin.auth().verifyIdToken(token);

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
      throw new Error(
        data?.error?.message ||
        `Image API returned HTTP ${response.status}`
      );
    }

    const item = data?.data?.[0];

    if (!item?.b64_json) {
      throw new Error(
        'The image model did not return an image.'
      );
    }

    return res.status(200).json({
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
