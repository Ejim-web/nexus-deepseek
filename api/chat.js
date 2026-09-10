const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !privateKey
  ) {
    throw new Error("Firebase server configuration is missing.");
  }

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey.replace(/\\n/g, "\n"),
    }),
  });
}

const MODEL = "openrouter/free";
const MAX_MESSAGE_LENGTH = 12000;
const MAX_CONTEXT_MESSAGES = 30;

function sendJson(res, status, data) {
  return res.status(status).json(data);
}

function systemPrompt() {
  return `
You are Nexus AI, a helpful global AI assistant.

Give accurate, useful and clear answers.

You are designed for people around the world. Respect different countries,
cultures, languages and backgrounds.

Use the user's language when practical.

Never claim that you performed an action when you did not actually perform it.

If you are uncertain, clearly say so instead of inventing information.

For coding requests, provide practical code and explain important setup
requirements.

For complex questions, organize your answer clearly.

Keep normal answers reasonably concise unless the user asks for detail.

You are operating inside the Nexus AI application.
`;
}

async function authenticate(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    throw new Error("Authentication required.");
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    throw new Error("Authentication token is missing.");
  }

  const app = getFirebaseAdmin();

  return admin.auth(app).verifyIdToken(token);
}

async function getConversationContext(uid, chatId) {
  if (!chatId) {
    return [];
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(chatId)) {
    throw new Error("Invalid chat ID.");
  }

  const app = getFirebaseAdmin();
  const db = admin.firestore(app);

  const chatRef = db
    .collection("users")
    .doc(uid)
    .collection("chats")
    .doc(chatId);

  const chatSnapshot = await chatRef.get();

  if (!chatSnapshot.exists) {
    return [];
  }

  const messagesSnapshot = await chatRef
    .collection("messages")
    .orderBy("createdAt", "asc")
    .limit(MAX_CONTEXT_MESSAGES)
    .get();

  return messagesSnapshot.docs
    .map((doc) => doc.data())
    .filter(
      (message) =>
        (message.role === "user" ||
          message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim()
    )
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_MESSAGE_LENGTH),
    }));
}

async function callOpenRouter(messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("Nexus AI server configuration is incomplete.");
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",

        "HTTP-Referer":
          process.env.APP_URL ||
          "https://nexus-ai.vercel.app",

        "X-Title": "Nexus AI",
      },

      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 4000,
      }),
    }
  );

  const rawResponse = await response.text();

  let data;

  try {
    data = JSON.parse(rawResponse);
  } catch {
    throw new Error(
      "AI provider returned an invalid response."
    );
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
        "The AI provider could not process the request."
    );
  }

  const text =
    data?.choices?.[0]?.message?.content;

  if (!text || typeof text !== "string") {
    throw new Error(
      "The AI provider returned an empty response."
    );
  }

  return {
    text: text.trim(),
    model: data?.model || MODEL,
  };
}

module.exports = async (req, res) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      error: "Method not allowed.",
    });
  }

  try {
    // Authenticate the Firebase user.
    const decodedUser = await authenticate(req);

    const body = req.body || {};

    const message = String(
      body.message || ""
    ).trim();

    const chatId = String(
      body.chatId || ""
    ).trim();

    // Validate message.
    if (!message) {
      return sendJson(res, 400, {
        error: "Please enter a message.",
      });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return sendJson(res, 400, {
        error:
          `Message is too long. Maximum length is ` +
          `${MAX_MESSAGE_LENGTH} characters.`,
      });
    }

    // Load previous messages belonging only
    // to the authenticated user's chat.
    const previousMessages =
      await getConversationContext(
        decodedUser.uid,
        chatId
      );

    const messages = [
      {
        role: "system",
        content: systemPrompt(),
      },

      ...previousMessages,

      {
        role: "user",
        content: message,
      },
    ];

    // Keep the request reasonably sized.
    const conversationMessages =
      messages.slice(
        -(MAX_CONTEXT_MESSAGES + 1)
      );

    // Always keep the system instruction first.
    const finalMessages = [
      {
        role: "system",
        content: systemPrompt(),
      },

      ...conversationMessages.filter(
        (message) => message.role !== "system"
      ),
    ];

    // Send the request to OpenRouter.
    const result =
      await callOpenRouter(finalMessages);

    return sendJson(res, 200, {
      ok: true,
      text: result.text,
      model: result.model,
    });

  } catch (error) {
    console.error(
      "Nexus AI API error:",
      error
    );

    const errorMessage = String(
      error?.message ||
        "Something went wrong."
    );

    if (
      /authentication|token|unauthenticated/i.test(
        errorMessage
      )
    ) {
      return sendJson(res, 401, {
        error:
          "Your session has expired. Please sign in again.",
      });
    }

    return sendJson(res, 500, {
      error: errorMessage,
    });
  }
};
