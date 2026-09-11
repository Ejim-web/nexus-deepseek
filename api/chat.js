const admin = require('firebase-admin');

const MODEL =
  process.env.NEXUS_MODEL ||
  'openrouter/free';

const VISION_MODEL =
  process.env.NEXUS_VISION_MODEL ||
  'openrouter/free';

function json(res, status, body) {
  return res.status(status).json(body);
}

function initFirebase() {
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    throw new Error(
      'Firebase server configuration is missing.'
    );
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:
          process.env.FIREBASE_PROJECT_ID,

        clientEmail:
          process.env.FIREBASE_CLIENT_EMAIL,

        privateKey:
          process.env.FIREBASE_PRIVATE_KEY.replace(
            /\\n/g,
            '\n'
          )
      })
    });
  }

  return admin.firestore();
}


/* ---------------------------------------
   MEMORY
--------------------------------------- */

function extractMemory(text) {
  const patterns = [
    /^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i,

    /^(?:please\s+)?keep\s+in\s+mind(?:\s+that)?\s+(.+)$/i,

    /^my\s+(?:preference|preferences)\s+(?:is|are)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match =
      String(text || '')
        .trim()
        .match(pattern);

    if (
      match &&
      match[1] &&
      match[1].trim().length >= 3
    ) {
      return match[1]
        .trim()
        .slice(0, 1000);
    }
  }

  return null;
}


async function getMemories(db, uid) {
  try {
    const snapshot =
      await db
        .collection('users')
        .doc(uid)
        .collection('memories')
        .orderBy('updatedAt', 'desc')
        .limit(40)
        .get();

    return snapshot.docs
      .map(doc => doc.data()?.text)
      .filter(Boolean);
  } catch (error) {
    console.warn(
      'Memory read skipped:',
      error?.message
    );

    return [];
  }
}


/* ---------------------------------------
   SYSTEM PROMPT
--------------------------------------- */

function buildSystem(memories) {
  return `
You are Nexus AI, a highly capable and helpful AI assistant.

Be accurate, useful, clear, and concise when appropriate.

Do not reveal hidden chain-of-thought or private internal reasoning.

You can help with:
- general questions
- research
- coding
- writing
- mathematics
- planning
- explanations
- image analysis
- creative tasks

For questions that require current or changing information,
use web research when it is available.

When web sources are provided, cite them naturally.

Never invent facts when you are uncertain.

The user may explicitly ask you to remember something.
The saved memories below may be used naturally.

LONG-TERM MEMORIES:
${
  memories.length
    ? memories
        .map(memory => `- ${memory}`)
        .join('\n')
    : '(none saved)'
}
`;
}


/* ---------------------------------------
   RESEARCH DETECTION
--------------------------------------- */

function shouldResearch(text) {
  return /\b(
    latest|
    today|
    current|
    recent|
    news|
    research|
    look\s*up|
    search|
    find\s+out|
    verify|
    sources?|
    price|
    prices|
    weather|
    market|
    this\s+week|
    this\s+month|
    2026
  )\b/ix.test(text || '');
}


/* ---------------------------------------
   OPENROUTER
--------------------------------------- */

async function callOpenRouter({
  messages,
  model,
  research
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

  const response = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
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

  const raw =
    await response.text();

  let data = {};

  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `OpenRouter returned HTTP ${response.status}`;

    const error =
      new Error(message);

    error.status =
      response.status;

    error.openrouter =
      data?.error || null;

    throw error;
  }

  return data;
}


/* ---------------------------------------
   EXTRACT RESPONSE
--------------------------------------- */

function extractText(choice) {
  if (!choice) {
    return '';
  }

  if (
    typeof choice.content ===
    'string'
  ) {
    return choice.content;
  }

  if (
    Array.isArray(choice.content)
  ) {
    return choice.content
      .map(part => {
        if (
          typeof part === 'string'
        ) {
          return part;
        }

        return part?.text || '';
      })
      .join('');
  }

  return '';
}


/* ---------------------------------------
   EXTRACT SOURCES
--------------------------------------- */

function extractSources(choice) {
  const annotations =
    Array.isArray(choice?.annotations)
      ? choice.annotations
      : [];

  return annotations
    .map(annotation =>
      annotation?.url_citation
    )
    .filter(Boolean)
    .map(citation => ({
      title:
        citation.title ||
        citation.url ||
        'Source',

      url:
        citation.url
    }))
    .filter(source => source.url);
}


/* ---------------------------------------
   MAIN HANDLER
--------------------------------------- */

module.exports = async function handler(
  req,
  res
) {
  if (req.method !== 'POST') {
    return json(
      res,
      405,
      {
        error:
          'Method not allowed.'
      }
    );
  }

  try {

    /* -------------------------------
       OPENROUTER KEY
    -------------------------------- */

    if (
      !process.env.OPENROUTER_API_KEY
    ) {
      return json(
        res,
        500,
        {
          error:
            'OPENROUTER_API_KEY is missing from Vercel environment variables.'
        }
      );
    }


    /* -------------------------------
       FIREBASE
    -------------------------------- */

    const db =
      initFirebase();


    /* -------------------------------
       AUTH
    -------------------------------- */

    const authHeader =
      req.headers.authorization ||
      '';

    if (
      !authHeader.startsWith(
        'Bearer '
      )
    ) {
      return json(
        res,
        401,
        {
          error:
            'Authentication required.'
        }
      );
    }

    const token =
      authHeader
        .slice(7)
        .trim();

    const decoded =
      await admin
        .auth()
        .verifyIdToken(token);

    const uid =
      decoded.uid;


    /* -------------------------------
       REQUEST DATA
    -------------------------------- */

    const message =
      String(
        req.body?.message || ''
      ).trim();

    const chatId =
      String(
        req.body?.chatId || ''
      ).trim();

    const imageData =
      req.body?.imageData ||
      null;

    const imageMime =
      req.body?.imageMime ||
      'image/jpeg';


    if (
      !message &&
      !imageData
    ) {
      return json(
        res,
        400,
        {
          error:
            'Message is empty.'
        }
      );
    }


    /* -------------------------------
       GET MEMORY
       If it fails, chat continues.
    -------------------------------- */

    let memories = [];

    try {
      memories =
        await getMemories(
          db,
          uid
        );
    } catch {
      memories = [];
    }


    /* -------------------------------
       GET CHAT HISTORY
       If history fails, chat continues.
    -------------------------------- */

    let history = [];

    if (chatId) {
      try {
        const snapshot =
          await db
            .collection('users')
            .doc(uid)
            .collection('chats')
            .doc(chatId)
            .collection('messages')
            .orderBy(
              'createdAt',
              'desc'
            )
            .limit(18)
            .get();

        history =
          snapshot.docs
            .reverse()
            .map(doc =>
              doc.data()
            )
            .filter(
              item =>
                item.role ===
                  'user' ||
                item.role ===
                  'assistant'
            );
      } catch (error) {
        console.warn(
          'Chat history skipped:',
          error?.message
        );

        history = [];
      }
    }


    /* -------------------------------
       USER CONTENT
    -------------------------------- */

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
          url:
            `data:${imageMime};base64,${imageData}`
        }
      });
    }


    /* -------------------------------
       MESSAGES
    -------------------------------- */

    const messages = [
      {
        role: 'system',

        content:
          buildSystem(memories)
      },

      ...history
        .slice(-12)
        .map(item => ({
          role:
            item.role,

          content:
            String(
              item.content || ''
            ).slice(
              0,
              12000
            )
        })),

      {
        role: 'user',

        content:
          imageData
            ? userContent
            : message
      }
    ];


    /* -------------------------------
       RESEARCH
    -------------------------------- */

    const research =
      shouldResearch(
        message
      );


    /* -------------------------------
       MODEL
    -------------------------------- */

    const selectedModel =
      imageData
        ? VISION_MODEL
        : MODEL;


    /* -------------------------------
       CALL OPENROUTER
    -------------------------------- */

    let data;

    try {

      data =
        await callOpenRouter({
          messages,
          model:
            selectedModel,
          research
        });

    } catch (firstError) {

      /*
       If web research caused the
       request to fail, retry without
       the web plugin.

       This prevents a research
       problem from breaking normal
       chat.
      */

      if (research) {

        console.warn(
          'Research request failed. Retrying without web search:',
          firstError?.message
        );

        data =
          await callOpenRouter({
            messages,
            model:
              selectedModel,
            research: false
          });

      } else {
        throw firstError;
      }
    }


    /* -------------------------------
       RESPONSE
    -------------------------------- */

    const choice =
      data?.choices?.[0]
        ?.message;

    const text =
      extractText(
        choice
      );


    if (!text) {
      return json(
        res,
        200,
        {
          text:
            'I received an empty response. Please try again.',

          model:
            data?.model ||
            selectedModel,

          sources: [],

          remembered: false
        }
      );
    }


    /* -------------------------------
       SOURCES
    -------------------------------- */

    const sources =
      extractSources(
        choice
      );


    /* -------------------------------
       SAVE MEMORY
       Never let memory saving
       break the AI response.
    -------------------------------- */

    const memory =
      extractMemory(
        message
      );

    if (memory) {
      try {

        await db
          .collection('users')
          .doc(uid)
          .collection('memories')
          .add({
            text:
              memory,

            createdAt:
              admin.firestore
                .FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          });

      } catch (error) {

        console.warn(
          'Memory save skipped:',
          error?.message
        );

      }
    }


    /* -------------------------------
       SUCCESS
    -------------------------------- */

    return json(
      res,
      200,
      {
        text,

        model:
          data?.model ||
          selectedModel,

        sources,

        remembered:
          !!memory
      }
    );


  } catch (error) {

    console.error(
      'Nexus chat error:',
      error
    );


    /*
     * Return the actual safe error
     * instead of hiding everything
     * behind "temporarily unavailable".
     */

    const message =
      error?.message ||
      'Nexus AI is temporarily unavailable.';

    return json(
      res,
      500,
      {
        error:
          message
      }
    );
  }
};
