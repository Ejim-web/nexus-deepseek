const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const OPENROUTER_API_KEY = defineSecret("OPENROUTER_API_KEY");

// Global-friendly AI routing.
// OpenRouter selects an available model through this route.
const MODEL = "openrouter/free";

const MAX_MESSAGE_LENGTH = 12000;
const MAX_CONTEXT_MESSAGES = 30;

function sendJson(res, status, data) {
  res.status(status);
  res.set("Content-Type", "application/json");
  res.json(data);
}

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}

async function authenticate(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    throw new Error("Authentication required.");
  }

  const idToken = header.substring(7).trim();

  if (!idToken) {
    throw new Error("Authentication token is missing.");
  }

  return admin.auth().verifyIdToken(idToken);
}

function cleanText(value) {
  return String(value || "").trim();
}

function buildSystemPrompt() {
  return `
You are Nexus AI, a helpful global AI assistant.

Your goals:
- Give accurate, useful and clear answers.
- Be helpful to people from any country.
- Respect different cultures, languages and backgrounds.
- Use the user's language when practical.
- Never claim to have performed an action you did not perform.
- If you are uncertain, say so rather than inventing facts.
- For coding requests, provide practical working code and explain important setup requirements.
- For complex questions, organize the answer clearly.
- Keep answers concise unless the user asks for detail.

You are operating inside the Nexus AI application.
`;
}

async function getConversationContext(uid, chatId) {
  if (!chatId) return [];

  const chatRef = db
    .collection("users")
    .doc(uid)
    .collection("chats")
    .doc(chatId);

  const chatSnap = await chatRef.get();

  if (!chatSnap.exists) {
    return [];
  }

  const messagesSnap = await chatRef
    .collection("messages")
    .orderBy("createdAt", "asc")
    .limit(MAX_CONTEXT_MESSAGES)
    .get();

  return messagesSnap.docs
    .map((doc) => doc.data())
    .filter((message) => {
      return (
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim()
      );
    })
    .map((message) => ({
      role: message.role,
      content: message.content.substring(0, MAX_MESSAGE_LENGTH),
    }));
}

async function callOpenRouter(messages) {
  const apiKey = OPENROUTER_API_KEY.value();

  if (!apiKey) {
    throw new Error("Nexus AI server configuration is incomplete.");
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://nexusai-50c52.web.app",
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

  const rawText = await response.text();

  let data;

  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error("AI provider returned an invalid response.");
  }

  if (!response.ok) {
    const providerMessage =
      data?.error?.message ||
      data?.message ||
      "The AI provider could not process the request.";

    throw new Error(providerMessage);
  }

  const text = data?.choices?.[0]?.message?.content;

  if (!text || typeof text !== "string") {
    throw new Error("The AI provider returned an empty response.");
  }

  return {
    text: text.trim(),
    model: data?.model || MODEL,
  };
}

exports.chat = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "512MiB",
    secrets: [OPENROUTER_API_KEY],
  },
  async (req, res) => {
    setCors(res);

    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, {
        error: "Method not allowed.",
      });
    }

    try {
      // ---------------------------------------------------------
      // 1. Verify Firebase user
      // ---------------------------------------------------------
      const decodedToken = await authenticate(req);
      const uid = decodedToken.uid;

      // ---------------------------------------------------------
      // 2. Validate request
      // ---------------------------------------------------------
      const body = req.body || {};

      const message = cleanText(body.message);
      const chatId = cleanText(body.chatId);

      if (!message) {
        return sendJson(res, 400, {
          error: "Please enter a message.",
        });
      }

      if (message.length > MAX_MESSAGE_LENGTH) {
        return sendJson(res, 400, {
          error: `Message is too long. Maximum length is ${MAX_MESSAGE_LENGTH} characters.`,
        });
      }

      // Prevent users from using arbitrary Firestore paths.
      if (chatId && !/^[a-zA-Z0-9_-]{1,128}$/.test(chatId)) {
        return sendJson(res, 400, {
          error: "Invalid chat ID.",
        });
      }

      // ---------------------------------------------------------
      // 3. Load this user's previous conversation
      // ---------------------------------------------------------
      const previousMessages = await getConversationContext(
        uid,
        chatId
      );

      // ---------------------------------------------------------
      // 4. Build AI request
      // ---------------------------------------------------------
      const aiMessages = [
        {
          role: "system",
          content: buildSystemPrompt(),
        },
        ...previousMessages,
        {
          role: "user",
          content: message,
        },
      ];

      // Keep payload under control.
      const trimmedMessages = aiMessages.slice(
        -(MAX_CONTEXT_MESSAGES + 1)
      );

      // Make sure the system instruction remains first.
      const finalMessages = [
        aiMessages[0],
        ...trimmedMessages.filter((_, index) => index !== 0),
      ];

      // ---------------------------------------------------------
      // 5. Call OpenRouter securely from the server
      // ---------------------------------------------------------
      const result = await callOpenRouter(finalMessages);

      // ---------------------------------------------------------
      // 6. Return AI response
      // ---------------------------------------------------------
      return sendJson(res, 200, {
        ok: true,
        text: result.text,
        model: result.model,
      });
    } catch (error) {
      console.error("Nexus AI backend error:", error);

      const message = error?.message || "Something went wrong.";

      // Never expose secrets or internal implementation details.
      if (
        message.toLowerCase().includes("token") ||
        message.toLowerCase().includes("authentication")
      ) {
        return sendJson(res, 401, {
          error: "Your session has expired. Please sign in again.",
        });
      }

      return sendJson(res, 500, {
        error: message,
      });
    }
  }
);
