const admin = require("firebase-admin");

const MODEL = process.env.NEXUS_MODEL || "openrouter/free";

// Free vision-capable models.
// openrouter/free automatically selects a free model that supports
// the capabilities required by the request, including image understanding.
const VISION_MODEL = process.env.NEXUS_VISION_MODEL || "openrouter/free";
const VISION_FALLBACK_MODEL =
  process.env.NEXUS_VISION_FALLBACK_MODEL ||
  "google/gemma-4-26b-a4b-it:free";

const MAX_IMAGE_BASE64_CHARS = 8000000;

function initFirebase() {
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    throw new Error("Firebase server configuration is missing.");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
      })
    });
  }

  return admin.firestore();
}

function json(res, status, body) {
  return res.status(status).json(body);
}

function extractMemories(text) {
  const patterns = [
    /^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i,
    /^(?:please\s+)?keep\s+in\s+mind\s+that\s+(.+)$/i,
    /^my\s+(?:preference|preferences)\s+(?:is|are)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = String(text || "").trim().match(pattern);

    if (match?.[1] && match[1].trim().length >= 3) {
      return match[1].trim().slice(0, 1000);
    }
  }

  return null;
}

async function getMemories(db, uid) {
  try {
    const snap = await db
      .collection("users")
      .doc(uid)
      .collection("memories")
      .orderBy("updatedAt", "desc")
      .limit(40)
      .get();

    return snap.docs
      .map((doc) => doc.data()?.text)
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

You can:
- analyze uploaded images
- read text in images
- inspect screenshots
- help with code
- solve calculations
- help with writing
- help with planning
- perform research
- answer questions
- help with creative work

When an image is uploaded, carefully inspect the image and answer the user's request based on what is actually visible.

The user may explicitly ask you to remember something. Explicit memories are provided below and should be used naturally.

Long-term memories:
${
  memories.length
    ? memories.map((x) => "- " + x).join("\n")
    : "(none saved)"
}`;
}

function shouldResearch(text) {
  return /\b(latest|today|current|recent|news|research|look\s*up|search|find\s+out|verify|sources?|price|prices|weather|market|2026|this\s+week|this\s+month)\b/i.test(
    String(text || "")
  );
}

function normalizeMime(mime) {
  const value = String(mime || "image/jpeg")
    .split(";")[0]
    .trim()
    .toLowerCase();

  const allowed = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif"
  ];

  return allowed.includes(value) ? value : "image/jpeg";
}

function cleanBase64Image(imageData) {
  let value = String(imageData || "").trim();

  if (!value) {
    return null;
  }

  // If the frontend accidentally sends a complete data URL,
  // remove the header because we add it ourselves.
  if (value.startsWith("data:")) {
    const comma = value.indexOf(",");

    if (comma === -1) {
      throw new Error("The uploaded image data is invalid.");
    }

    value = value.slice(comma + 1);
  }

  // Remove whitespace/newlines that sometimes appear in base64.
  value = value.replace(/\s+/g, "");

  // Basic base64 validation.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("The uploaded image data is invalid.");
  }

  if (value.length > MAX_IMAGE_BASE64_CHARS) {
    throw new Error(
      "This image is too large. Please choose a smaller image and try again."
    );
  }

  return value;
}

function extractTextFromChoice(choice) {
  if (!choice) {
    return "I could not generate a response.";
  }

  if (typeof choice.content === "string") {
    return choice.content.trim() || "I could not generate a response.";
  }

  if (Array.isArray(choice.content)) {
    const text = choice.content
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text || "";
      })
      .join("")
      .trim();

    return text || "I could not generate a response.";
  }

  return "I could not generate a response.";
}

function getSources(choice) {
  const annotations = Array.isArray(choice?.annotations)
    ? choice.annotations
    : [];

  return annotations
    .map((item) => item?.url_citation)
    .filter(Boolean)
    .map((item) => ({
      title: item.title || item.url || "Source",
      url: item.url
    }))
    .filter((item) => item.url);
}

function makeProviderError(responseStatus, data, raw) {
  const providerError = data?.error;

  let message =
    providerError?.message ||
    providerError?.error?.message ||
    providerError?.details ||
    "";

  if (!message && typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      message =
        parsed?.error?.message ||
        parsed?.error?.details ||
        parsed?.message ||
        "";
    } catch {
      message = raw.slice(0, 500);
    }
  }

  if (!message) {
    message = `OpenRouter returned HTTP ${responseStatus}.`;
  }

  const error = new Error(message);
  error.status = responseStatus;
  error.providerError = providerError || null;

  return error;
}

async function callOpenRouter({
  messages,
  research = false,
  model = MODEL
}) {
  const body = {
    model,
    messages,
    temperature: 0.2
  };

  // IMPORTANT:
  // Do not attach the web plugin to image requests.
  // Image understanding and web research are separate paths.
  if (research) {
    body.plugins = [
      {
        id: "web",
        max_results: 5
      }
    ];
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.APP_URL ||
          "https://nexus-deepseek.vercel.app",
        "X-Title": "Nexus AI"
      },
      body: JSON.stringify(body)
    }
  );

  const raw = await response.text();

  let data = {};

  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw makeProviderError(response.status, data, raw);
  }

  if (!data?.choices?.length) {
    throw new Error("OpenRouter returned no AI response.");
  }

  return data;
}

async function callVisionWithFallback(messages) {
  let firstError = null;

  // First vision attempt.
  try {
    const result = await callOpenRouter({
      messages,
      research: false,
      model: VISION_MODEL
    });

    return {
      data: result,
      model: result.model || VISION_MODEL
    };
  } catch (error) {
    firstError = error;

    console.error("Nexus primary vision model failed:", {
      model: VISION_MODEL,
      status: error?.status,
      message: error?.message
    });
  }

  // Automatic vision fallback.
  if (VISION_FALLBACK_MODEL && VISION_FALLBACK_MODEL !== VISION_MODEL) {
    try {
      const result = await callOpenRouter({
        messages,
        research: false,
        model: VISION_FALLBACK_MODEL
      });

      return {
        data: result,
        model: result.model || VISION_FALLBACK_MODEL
      };
    } catch (fallbackError) {
      console.error("Nexus fallback vision model failed:", {
        model: VISION_FALLBACK_MODEL,
        status: fallbackError?.status,
        message: fallbackError?.message
      });

      const firstMessage =
        firstError?.message || "Primary vision model failed.";

      const fallbackMessage =
        fallbackError?.message || "Fallback vision model failed.";

      throw new Error(
        `Image analysis failed. Primary: ${firstMessage}. Fallback: ${fallbackMessage}`
      );
    }
  }

  throw firstError || new Error("Image analysis failed.");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      error: "Method not allowed."
    });
  }

  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return json(res, 500, {
        error: "OPENROUTER_API_KEY is missing."
      });
    }

    const db = initFirebase();

    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return json(res, 401, {
        error: "Authentication required."
      });
    }

    const token = authHeader.slice(7).trim();

    if (!token) {
      return json(res, 401, {
        error: "Authentication token is missing."
      });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    const uid = decoded.uid;

    const message = String(req.body?.message || "").trim();
    const chatId = String(req.body?.chatId || "").trim();

    const rawImageData = req.body?.imageData || null;
    const imageMime = normalizeMime(req.body?.imageMime);

    if (!message && !rawImageData) {
      return json(res, 400, {
        error: "Message is empty."
      });
    }

    let imageData = null;

    if (rawImageData) {
      imageData = cleanBase64Image(rawImageData);

      if (!imageData) {
        return json(res, 400, {
          error: "The uploaded image is empty."
        });
      }
    }

    // Load memories and recent chat context.
    const [memories, contextSnap] = await Promise.all([
      getMemories(db, uid),

      chatId
        ? db
            .collection("users")
            .doc(uid)
            .collection("chats")
            .doc(chatId)
            .collection("messages")
            .orderBy("createdAt", "desc")
            .limit(18)
            .get()
        : null
    ]);

    const history = contextSnap
      ? contextSnap.docs
          .reverse()
          .map((doc) => doc.data())
          .filter(
            (item) =>
              item.role === "user" ||
              item.role === "assistant"
          )
      : [];

    const userContent = [];

    // IMPORTANT:
    // OpenRouter expects the text part first, followed by image_url.
    if (message) {
      userContent.push({
        type: "text",
        text: message
      });
    } else {
      userContent.push({
        type: "text",
        text:
          "Please analyze this image carefully. Describe what is visible and help me understand it."
      });
    }

    if (imageData) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${imageMime};base64,${imageData}`
        }
      });
    }

    const messages = [
      {
        role: "system",
        content: buildSystem(memories)
      },

      ...history.slice(-12).map((item) => ({
        role: item.role,
        content: String(item.content || "").slice(0, 12000)
      })),

      {
        role: "user",
        content: imageData ? userContent : message
      }
    ];

    let data;
    let usedModel;

    if (imageData) {
      // IMAGE PATH
      //
      // No web plugin here.
      // Vision model + automatic fallback.
      const visionResult = await callVisionWithFallback(messages);

      data = visionResult.data;
      usedModel = visionResult.model;
    } else {
      // NORMAL TEXT PATH
      const research = shouldResearch(message);

      data = await callOpenRouter({
        messages,
        research,
        model: MODEL
      });

      usedModel = data.model || MODEL;
    }

    const choice = data?.choices?.[0]?.message || {};

    const text = extractTextFromChoice(choice);

    const sources = getSources(choice);

    // Save explicit user memories.
    const memory = extractMemories(message);

    if (memory) {
      await db
        .collection("users")
        .doc(uid)
        .collection("memories")
        .add({
          text: memory,
          createdAt:
            admin.firestore.FieldValue.serverTimestamp(),
          updatedAt:
            admin.firestore.FieldValue.serverTimestamp()
        });
    }

    return json(res, 200, {
      text,
      model: usedModel,
      sources,
      remembered: !!memory
    });
  } catch (error) {
    console.error("Nexus chat error:", {
      message: error?.message,
      status: error?.status,
      providerError: error?.providerError
    });

    let userMessage =
      error?.message ||
      "Nexus AI is temporarily unavailable.";

    // Make some provider errors easier for the user to understand.
    if (/no endpoints found.*image/i.test(userMessage)) {
      userMessage =
        "The selected AI provider cannot process images right now. Nexus AI tried another vision model automatically, but it was also unavailable.";
    }

    if (/context.?length|too large|maximum.*tokens/i.test(userMessage)) {
      userMessage =
        "The image or conversation is too large for the selected AI model. Please use a smaller image or start a new chat.";
    }

    if (/rate.?limit|429/i.test(userMessage)) {
      userMessage =
        "The AI provider is temporarily rate-limited. Please wait a moment and try again.";
    }

    return json(res, 500, {
      error: userMessage
    });
  }
};
