const admin = require("firebase-admin");

const TEXT_MODEL = "openrouter/free";
const IMAGE_MODEL = "google/gemini-3.1-flash-image";

const MAX_MESSAGE_LENGTH = 12000;
const MAX_CONTEXT_MESSAGES = 30;
const MAX_IMAGE_DATA_LENGTH = 12 * 1024 * 1024;

let firebaseApp = null;

function getFirebaseAdmin() {
  if (firebaseApp) return firebaseApp;

  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!privateKey || !projectId || !clientEmail) {
    throw new Error(
      "Missing Firebase environment variables: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }

  firebaseApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.replace(/\\n/g, "\n"),
        }),
      });

  return firebaseApp;
}

function openRouterHeaders() {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer":
      process.env.APP_URL || "https://nexus-ai.vercel.app",
    "X-Title": "Nexus AI",
  };
}

function systemPrompt() {
  return `
You are Nexus AI, a helpful, intelligent, accurate and friendly AI assistant.

Rules:
- Answer the user's request directly and clearly.
- Be honest when you are uncertain.
- Do not claim to have performed actions you cannot actually perform.
- Use the conversation context when it is relevant.
- Keep answers readable and useful.
- For coding requests, provide practical working solutions.
`;
}

async function authenticate(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    const error = new Error(
      "Missing Firebase authentication token"
    );
    error.statusCode = 401;
    throw error;
  }

  const token = authorization
    .slice("Bearer ".length)
    .trim();

  if (!token) {
    const error = new Error(
      "Empty Firebase authentication token"
    );
    error.statusCode = 401;
    throw error;
  }

  const app = getFirebaseAdmin();

  return admin.auth(app).verifyIdToken(token);
}

async function getConversationContext(uid, chatId) {
  if (!uid || !chatId) return [];

  const db = getFirebaseAdmin();

  const snapshot = await db
    .firestore()
    .collection("users")
    .doc(uid)
    .collection("chats")
    .doc(chatId)
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(MAX_CONTEXT_MESSAGES)
    .get();

  const messages = [];

  snapshot.docs.reverse().forEach((doc) => {
    const data = doc.data();

    if (
      data.role !== "user" &&
      data.role !== "assistant"
    ) {
      return;
    }

    if (
      typeof data.content === "string" &&
      data.content.trim()
    ) {
      messages.push({
        role: data.role,
        content: data.content.slice(
          0,
          MAX_MESSAGE_LENGTH
        ),
      });
    }
  });

  return messages;
}

async function callOpenRouter(messages) {
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: openRouterHeaders(),
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 4000,
      }),
    }
  );

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `OpenRouter returned invalid JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok) {
    const providerMessage =
      data?.error?.message ||
      data?.message ||
      `OpenRouter request failed with HTTP ${response.status}`;

    const error = new Error(providerMessage);
    error.statusCode = response.status;

    throw error;
  }

  const content =
    data?.choices?.[0]?.message?.content;

  if (
    typeof content !== "string" ||
    !content.trim()
  ) {
    throw new Error(
      "OpenRouter returned an empty assistant response"
    );
  }

  return {
    text: content,
    model: data?.model || TEXT_MODEL,
    usage: data?.usage || null,
  };
}

function createUserMessage(message, imageUrl) {
  if (!imageUrl) {
    return {
      role: "user",
      content: message,
    };
  }

  if (typeof imageUrl !== "string") {
    throw new Error("imageUrl must be a string");
  }

  if (
    imageUrl.length >
    MAX_IMAGE_DATA_LENGTH
  ) {
    throw new Error(
      "Image is too large. Maximum image payload is 12 MB."
    );
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          message ||
          "Please analyze this image.",
      },
      {
        type: "image_url",
        image_url: {
          url: imageUrl,
        },
      },
    ],
  };
}

async function generateImage(prompt, options = {}) {
  if (
    !prompt ||
    typeof prompt !== "string"
  ) {
    throw new Error(
      "Image prompt is required"
    );
  }

  const body = {
    model: IMAGE_MODEL,
    prompt: prompt.slice(
      0,
      MAX_MESSAGE_LENGTH
    ),
    n: 1,
  };

  if (options.aspect_ratio) {
    body.aspect_ratio =
      String(options.aspect_ratio);
  }

  if (options.resolution) {
    body.resolution =
      String(options.resolution);
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/images",
    {
      method: "POST",
      headers: openRouterHeaders(),
      body: JSON.stringify(body),
    }
  );

  const raw = await response.text();

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      `OpenRouter image endpoint returned invalid JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok) {
    const providerMessage =
      data?.error?.message ||
      data?.message ||
      `Image generation failed with HTTP ${response.status}`;

    const error = new Error(providerMessage);
    error.statusCode = response.status;

    throw error;
  }

  const images = Array.isArray(data?.data)
    ? data.data
        .map((item) => {
          if (item?.b64_json) {
            return `data:image/png;base64,${item.b64_json}`;
          }

          if (item?.url) {
            return item.url;
          }

          return null;
        })
        .filter(Boolean)
    : [];

  if (!images.length) {
    throw new Error(
      "OpenRouter did not return a generated image"
    );
  }

  return {
    images,
    model: data?.model || IMAGE_MODEL,
    usage: data?.usage || null,
  };
}

function setCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
}

function sendError(res, error) {
  const status =
    error?.statusCode === 401
      ? 401
      : error?.statusCode === 402
      ? 402
      : error?.statusCode === 429
      ? 429
      : 500;

  console.error(
    "Nexus AI API error:",
    error
  );

  res.status(status).json({
    ok: false,
    error:
      status === 500
        ? "Nexus AI is temporarily unavailable. Please try again."
        : error.message ||
          "Request failed",
    code: status,
  });
}

module.exports = async function handler(
  req,
  res
) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error:
        "Method not allowed. Use POST.",
    });
  }

  try {
    const user = await authenticate(req);

    const body = req.body || {};

    const chatId =
      typeof body.chatId === "string"
        ? body.chatId.trim()
        : "";

    const message =
      typeof body.message === "string"
        ? body.message.trim()
        : "";

    const imageUrl =
      typeof body.imageUrl === "string"
        ? body.imageUrl.trim()
        : "";

    const wantsImage =
      body.generateImage === true ||
      body.mode === "image" ||
      body.type ===
        "image_generation";

    // IMAGE GENERATION
    if (wantsImage) {
      const prompt =
        typeof body.prompt === "string"
          ? body.prompt.trim()
          : message;

      if (!prompt) {
        return res.status(400).json({
          ok: false,
          error:
            "Image prompt is required.",
        });
      }

      const result =
        await generateImage(prompt, {
          aspect_ratio:
            body.aspect_ratio,
          resolution:
            body.resolution,
        });

      return res.status(200).json({
        ok: true,
        type: "image",
        images: result.images,
        model: result.model,
        usage: result.usage,
      });
    }

    // NORMAL CHAT / IMAGE UNDERSTANDING
    if (!message && !imageUrl) {
      return res.status(400).json({
        ok: false,
        error:
          "Message or image is required.",
      });
    }

    if (
      message.length >
      MAX_MESSAGE_LENGTH
    ) {
      return res.status(400).json({
        ok: false,
        error:
          `Message is too long. Maximum length is ${MAX_MESSAGE_LENGTH} characters.`,
      });
    }

    const context =
      await getConversationContext(
        user.uid,
        chatId
      );

    const userMessage =
      createUserMessage(
        message ||
          "Please analyze this image.",
        imageUrl
      );

    const result =
      await callOpenRouter([
        {
          role: "system",
          content: systemPrompt(),
        },
        ...context,
        userMessage,
      ]);

    return res.status(200).json({
      ok: true,
      type: "text",
      text: result.text,
      model: result.model,
      usage: result.usage,
    });
  } catch (error) {
    return sendError(res, error);
  }
};
