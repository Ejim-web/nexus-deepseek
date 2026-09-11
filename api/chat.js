const admin = require("firebase-admin");

const MODEL = process.env.NEXUS_MODEL || "openrouter/free";
const VISION_MODEL =
  process.env.NEXUS_VISION_MODEL || "openrouter/free";

const VISION_FALLBACK_MODEL =
  "google/gemma-4-26b-a4b-it:free";

const MAX_MESSAGE_LENGTH = 12000;
const MAX_CONTEXT_MESSAGES = 18;
const MAX_IMAGE_BASE64_CHARS = 8000000;

function json(res, status, body) {
  return res.status(status).json(body);
}

function initFirebase() {
  if (admin.apps.length) {
    return admin.app();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    const missing = [];

    if (!projectId) missing.push("FIREBASE_PROJECT_ID");
    if (!clientEmail) missing.push("FIREBASE_CLIENT_EMAIL");
    if (!privateKey) missing.push("FIREBASE_PRIVATE_KEY");

    const error = new Error(
      `Firebase server configuration missing: ${missing.join(", ")}`
    );

    error.code = "SERVER_CONFIG_MISSING";
    throw error;
  }

  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n")
    })
  });
}

function getDb() {
  initFirebase();
  return admin.firestore();
}

async function verifyUser(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    const error = new Error(
      "Authentication token was not provided."
    );
    error.code = "AUTH_HEADER_MISSING";
    throw error;
  }

  const token = header.slice(7).trim();

  if (!token) {
    const error = new Error(
      "Authentication token is empty."
    );
    error.code = "AUTH_TOKEN_EMPTY";
    throw error;
  }

  initFirebase();

  try {
    return await admin.auth().verifyIdToken(token);
  } catch (error) {
    error.code = error.code || "AUTH_TOKEN_INVALID";
    throw error;
  }
}

function extractMemories(text) {
  const patterns = [
    /^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i,
    /^(?:please\s+)?keep\s+in\s+mind\s+that\s+(.+)$/i,
    /^my\s+(?:preference|preferences)\s+(?:is|are)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = String(text || "")
      .trim()
      .match(pattern);

    if (
      match &&
      match[1] &&
      match[1].trim().length >= 3
    ) {
      return match[1].trim().slice(0, 1000);
    }
  }

  return null;
}

async function getMemories(db, uid) {
  try {
    const snapshot = await db
      .collection("users")
      .doc(uid)
      .collection("memories")
      .orderBy("updatedAt", "desc")
      .limit(40)
      .get();

    return snapshot.docs
      .map(doc => doc.data()?.text)
      .filter(Boolean);
  } catch (error) {
    console.error(
      "Memory loading failed:",
      error?.message
    );

    return [];
  }
}

function isAuthenticityRequest(text) {
  return /\b(fake|fraud|fraudulent|scam|scammer|forged|forgery|counterfeit|genuine|authentic|authenticity|real|legit|legitimate|suspicious|verify|verification|validate|valid|invalid|edited|manipulated|tampered|photoshop|photoshopped|fake\s+receipt|fake\s+payment|fake\s+transfer|fake\s+document|fake\s+screenshot|fake\s+website|fake\s+product|fake\s+account|fake\s+invoice)\b/i.test(
    String(text || "")
  );
}

function buildSystem(memories, authenticityMode) {
  const authenticityInstructions =
    authenticityMode
      ? `

AUTHENTICITY / FAKE-CHECK MODE:

The user is asking whether an uploaded image, screenshot, receipt, payment confirmation, document, product, website, account, or other visual item may be fake, forged, edited, manipulated, fraudulent, or genuine.

Analyze the actual visible evidence carefully.

Do NOT automatically call something fake simply because it looks unusual.

Do NOT automatically call something genuine simply because it looks professional.

Do NOT claim certainty when the image alone cannot establish authenticity.

Look carefully for:

- inconsistent fonts
- spacing or alignment problems
- strange logos
- incorrect branding
- unusual colors
- inconsistent dates or times
- impossible amounts
- suspicious transaction formatting
- spelling or grammar errors
- mismatched currencies
- suspicious reference numbers
- inconsistent names
- duplicated text
- distorted text
- editing artifacts
- suspicious cropping
- manipulation clues
- impossible UI elements
- suspicious URLs or domains
- inconsistent branding
- missing expected information
- unusual payment wording
- unusual banking wording
- visual elements that appear copied or modified

Use this structure whenever possible:

## Authenticity Assessment

**Verdict:** Likely genuine / Suspicious / Likely fake / Cannot determine

**Confidence:** Low / Medium / High

## Evidence

List the specific visible clues supporting the assessment.

## What Cannot Be Verified

Explain what the image alone cannot prove.

## What To Check

Give practical steps the user can take to independently verify it.

If there is not enough evidence, clearly say:

**I cannot reliably determine authenticity from this image alone.**

For financial transactions, receipts, bank transfers, payment screenshots, gift cards, invoices, IDs, or other important documents, make it clear that visual analysis is NOT proof that the transaction or document is genuine.

Recommend verification through the official service, transaction history, reference number, recipient account, or issuing organization.
`
      : "";

  return `You are NexusMind AI, a highly capable, careful and intelligent global AI assistant.

Be accurate, useful, clear, and direct.

Use Markdown formatting when useful.

Use bold headings and organized lists for complex answers.

Do not expose hidden chain-of-thought.

Never claim that you performed an action you did not perform.

If you are uncertain, say so instead of inventing facts.

You can:

- analyze uploaded images
- read text from images
- inspect screenshots
- analyze documents shown in images
- help with code
- solve calculations
- write and rewrite content
- research information
- answer questions
- help with planning
- explain technical subjects

For current or changing information, use web search when it is enabled.

When sources are available, provide useful source links.

${authenticityInstructions}

The user may explicitly ask you to remember something.

Use saved memories naturally.

Long-term memories:
${
  memories.length
    ? memories.map(x => "- " + x).join("\n")
    : "(none saved)"
}`;
}

function shouldResearch(text) {
  return /\b(latest|today|current|recent|news|research|look\s*up|search|find\s+out|verify|source|sources|price|prices|weather|market|2026|this\s+week|this\s+month)\b/i.test(
    String(text || "")
  );
}

function cleanBase64Image(value) {
  if (!value) {
    return null;
  }

  let image = String(value).trim();

  if (image.startsWith("data:")) {
    const comma = image.indexOf(",");

    if (comma !== -1) {
      image = image.slice(comma + 1);
    }
  }

  image = image.replace(/\s/g, "");

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image)) {
    throw new Error("Invalid image data.");
  }

  if (image.length > MAX_IMAGE_BASE64_CHARS) {
    throw new Error(
      "Image is too large. Please upload an image under 8 MB."
    );
  }

  return image;
}

function normalizeMime(mime) {
  const value = String(
    mime || "image/jpeg"
  )
    .toLowerCase()
    .split(";")[0]
    .trim();

  const allowed = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ];

  return allowed.includes(value)
    ? value
    : "image/jpeg";
}

async function getConversationHistory(
  db,
  uid,
  chatId
) {
  if (!chatId) {
    return [];
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(chatId)) {
    const error = new Error(
      "Invalid chat ID."
    );
    error.code = "INVALID_CHAT_ID";
    throw error;
  }

  try {
    const snapshot = await db
      .collection("users")
      .doc(uid)
      .collection("chats")
      .doc(chatId)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(MAX_CONTEXT_MESSAGES)
      .get();

    return snapshot.docs
      .reverse()
      .map(doc => doc.data())
      .filter(
        message =>
          (message.role === "user" ||
            message.role === "assistant") &&
          typeof message.content === "string" &&
          message.content.trim()
      )
      .map(message => ({
        role: message.role,
        content: message.content.slice(
          0,
          MAX_MESSAGE_LENGTH
        )
      }));
  } catch (error) {
    console.error(
      "Chat history loading failed:",
      error?.message
    );

    return [];
  }
}

async function callOpenRouter({
  messages,
  model,
  research = false
}) {
  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    const error = new Error(
      "OpenRouter server configuration is missing."
    );

    error.code = "OPENROUTER_KEY_MISSING";
    throw error;
  }

  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 5000
  };

  if (research) {
    body.plugins = [
      {
        id: "web",
        max_results: 5
      }
    ];
  }

  let response;

  try {
    response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer":
            process.env.APP_URL ||
            "https://nexus-deepseek.vercel.app",
          "X-Title": "NexusMind AI"
        },
        body: JSON.stringify(body)
      }
    );
  } catch (error) {
    error.code =
      "OPENROUTER_NETWORK_ERROR";
    throw error;
  }

  const raw = await response.text();

  let data = {};

  try {
    data = JSON.parse(raw);
  } catch (error) {
    const invalidResponse =
      new Error(
        "OpenRouter returned an invalid response."
      );

    invalidResponse.code =
      "OPENROUTER_INVALID_RESPONSE";

    throw invalidResponse;
  }

  if (!response.ok) {
    const providerMessage =
      data?.error?.message ||
      data?.error?.metadata?.raw ||
      `OpenRouter returned HTTP ${response.status}`;

    const error = new Error(
      providerMessage
    );

    error.code =
      "OPENROUTER_HTTP_ERROR";

    error.providerStatus =
      response.status;

    throw error;
  }

  return data;
}

function extractText(choice) {
  if (!choice) {
    return "I could not generate a response.";
  }

  if (typeof choice.content === "string") {
    return choice.content.trim();
  }

  if (Array.isArray(choice.content)) {
    return choice.content
      .map(part => {
        if (typeof part === "string") {
          return part;
        }

        return part?.text || "";
      })
      .join("")
      .trim();
  }

  return "I could not generate a response.";
}

function extractSources(choice) {
  const sources = [];

  if (Array.isArray(choice?.annotations)) {
    for (const annotation of choice.annotations) {
      const citation =
        annotation?.url_citation;

      if (citation?.url) {
        sources.push({
          title:
            citation.title ||
            citation.url,
          url: citation.url
        });
      }
    }
  }

  return sources.slice(0, 5);
}

function buildImageUserContent(
  message,
  imageData,
  imageMime,
  authenticityMode
) {
  let imagePrompt =
    String(message || "").trim();

  if (!imagePrompt) {
    imagePrompt =
      "Analyze this image carefully and explain what is visible.";
  }

  if (authenticityMode) {
    imagePrompt = `The user wants an authenticity/fake check.

User's request:
${imagePrompt}

Carefully inspect the uploaded image for visible evidence that could indicate authenticity, editing, manipulation, fraud, forgery, or suspicious inconsistencies.

Do not guess.

Do not invent hidden information.

Separate visible evidence from assumptions.

Give a clear verdict with confidence level and explain what the user should independently verify.`;
  }

  return [
    {
      type: "text",
      text: imagePrompt
    },
    {
      type: "image_url",
      image_url: {
        url: `data:${imageMime};base64,${imageData}`
      }
    }
  ];
}

module.exports = async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed."
    });
  }

  try {
    const apiKey =
      process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      return json(res, 500, {
        ok: false,
        error:
          "OPENROUTER_API_KEY is missing."
      });
    }

    const db = getDb();

    const decoded =
      await verifyUser(req);

    const uid = decoded.uid;

    const body = req.body || {};

    const message = String(
      body.message || ""
    ).trim();

    const chatId = String(
      body.chatId || ""
    ).trim();

    let imageData =
      body.imageData || null;

    const imageMime =
      normalizeMime(body.imageMime);

    if (!message && !imageData) {
      return json(res, 400, {
        ok: false,
        error: "Message is empty."
      });
    }

    if (
      message.length >
      MAX_MESSAGE_LENGTH
    ) {
      return json(res, 400, {
        ok: false,
        error:
          `Message is too long. Maximum is ${MAX_MESSAGE_LENGTH} characters.`
      });
    }

    if (imageData) {
      imageData =
        cleanBase64Image(imageData);
    }

    const [
      memories,
      history
    ] = await Promise.all([
      getMemories(db, uid),
      getConversationHistory(
        db,
        uid,
        chatId
      )
    ]);

    const authenticityMode =
      !!imageData &&
      isAuthenticityRequest(
        message
      );

    const system =
      buildSystem(
        memories,
        authenticityMode
      );

    let userContent;

    if (imageData) {
      userContent =
        buildImageUserContent(
          message,
          imageData,
          imageMime,
          authenticityMode
        );
    } else {
      userContent = message;
    }

    const messages = [
      {
        role: "system",
        content: system
      },
      ...history.slice(-12),
      {
        role: "user",
        content: userContent
      }
    ];

    let data;
    let usedModel;

    /*
     * IMAGE / VISION MODE
     */
    if (imageData) {
      usedModel =
        VISION_MODEL;

      try {
        data =
          await callOpenRouter({
            messages,
            model: VISION_MODEL,
            research: false
          });
      } catch (firstError) {
        console.error(
          "Primary vision model failed:",
          firstError?.message
        );

        if (
          VISION_MODEL ===
          VISION_FALLBACK_MODEL
        ) {
          throw firstError;
        }

        usedModel =
          VISION_FALLBACK_MODEL;

        data =
          await callOpenRouter({
            messages,
            model:
              VISION_FALLBACK_MODEL,
            research: false
          });
      }
    } else {
      /*
       * NORMAL TEXT MODE
       */
      usedModel = MODEL;

      data =
        await callOpenRouter({
          messages,
          model: MODEL,
          research:
            shouldResearch(message)
        });
    }

    const choice =
      data?.choices?.[0]?.message ||
      {};

    const text =
      extractText(choice);

    const sources =
      extractSources(choice);

    /*
     * Save explicit memories.
     */
    const memory =
      extractMemories(message);

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
      ok: true,
      text,
      model:
        data?.model ||
        usedModel,
      sources,
      remembered: !!memory,
      authenticityCheck:
        authenticityMode
    });
  } catch (error) {
    console.error(
      "NexusMind AI chat error:",
      error
    );

    return json(res, 500, {
      ok: false,
      error:
        error?.message ||
        "NexusMind AI is temporarily unavailable."
    });
  }
};
