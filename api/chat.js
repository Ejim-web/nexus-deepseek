const admin = require("firebase-admin");

const TEXT_MODEL = "openrouter/free";
const VISION_MODEL = "google/gemma-4-26b-a4b-it:free";

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

        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(
          /\\n/g,
          "\n"
        )
      })
    });
  }

  return admin.firestore();
}

function json(res, status, body) {
  return res.status(status).json(body);
}

/* ---------------------------------------------------------
   LONG-TERM MEMORY
--------------------------------------------------------- */

function extractMemory(text) {
  const value = String(text || "").trim();

  const patterns = [
    /^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i,
    /^(?:please\s+)?keep\s+in\s+mind(?:\s+that)?\s+(.+)$/i,
    /^my\s+(?:preference|preferences)\s+(?:is|are)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);

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
    const snapshot = await db
      .collection("users")
      .doc(uid)
      .collection("memories")
      .orderBy("updatedAt", "desc")
      .limit(40)
      .get();

    return snapshot.docs
      .map((doc) => {
        const data = doc.data() || {};
        return data.text;
      })
      .filter(Boolean);
  } catch (error) {
    console.error("Memory loading error:", error);

    return [];
  }
}

/* ---------------------------------------------------------
   SYSTEM PROMPT
--------------------------------------------------------- */

function buildSystemPrompt(memories) {
  const memoryText =
    memories.length > 0
      ? memories
          .map((memory) => `- ${memory}`)
          .join("\n")
      : "(none saved)";

  return `
You are Nexus AI, a highly capable, helpful and careful AI assistant.

Your goals:

- Give accurate and useful answers.
- Be clear and direct.
- Do not invent facts.
- If information is uncertain, say so.
- Help with coding, research, writing, planning, mathematics,
  troubleshooting, business ideas and general questions.
- You can analyze images when an image is provided.
- When an image is provided, actually inspect the image and
  describe or analyze what is visible.
- Never claim that you cannot see an image when an image has
  actually been provided to you.
- Do not expose hidden chain-of-thought.
- Provide concise reasoning or explanations when useful.
- Respect the user's instructions.
- For current or changing information, research may be enabled
  by the server.

LONG-TERM NEXUS MEMORIES:

${memoryText}
`;
}

/* ---------------------------------------------------------
   RESEARCH DETECTION
--------------------------------------------------------- */

/*
  IMPORTANT:
  This is intentionally written as ONE LINE.

  JavaScript regex literals cannot contain ordinary line breaks.
*/

function shouldResearch(text) {
  return /\b(latest|today|current|recent|news|research|look\s*up|search|find\s+out|verify|source|sources|price|prices|weather|market|2026|this\s+week|this\s+month)\b/i.test(
    String(text || "")
  );
}

/* ---------------------------------------------------------
   IMAGE HANDLING
--------------------------------------------------------- */

function cleanBase64Image(value) {
  if (!value) {
    return null;
  }

  let image = String(value).trim();

  if (image.startsWith("data:")) {
    const commaIndex = image.indexOf(",");

    if (commaIndex !== -1) {
      image = image.slice(commaIndex + 1);
    }
  }

  image = image.replace(/\s/g, "");

  if (!image) {
    return null;
  }

  if (!/^[A-Za-z0-9+/=_-]+$/.test(image)) {
    throw new Error("The uploaded image data is invalid.");
  }

  return image;
}

function normalizeImageMime(mime) {
  const value = String(mime || "")
    .toLowerCase()
    .trim();

  const allowed = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif"
  ];

  if (allowed.includes(value)) {
    return value === "image/jpg"
      ? "image/jpeg"
      : value;
  }

  return "image/jpeg";
}

/* ---------------------------------------------------------
   OPENROUTER
--------------------------------------------------------- */

async function callOpenRouter({
  messages,
  model,
  research = false
}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is missing.");
  }

  const requestBody = {
    model,
    messages,
    temperature: 0.2
  };

  /*
    Only enable web research for normal text requests.

    Image requests deliberately do NOT use the web plugin.
  */
  if (research) {
    requestBody.plugins = [
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
        Authorization:
          `Bearer ${process.env.OPENROUTER_API_KEY}`,

        "Content-Type":
          "application/json",

        "HTTP-Referer":
          process.env.APP_URL ||
          "https://nexus-deepseek.vercel.app",

        "X-Title":
          "Nexus AI"
      },

      body: JSON.stringify(requestBody)
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
    const providerMessage =
      data?.error?.message ||
      data?.message ||
      raw ||
      `OpenRouter returned HTTP ${response.status}`;

    throw new Error(providerMessage);
  }

  return data;
}

/* ---------------------------------------------------------
   RESPONSE EXTRACTION
--------------------------------------------------------- */

function extractAssistantText(data) {
  const choice =
    data?.choices?.[0]?.message;

  if (!choice) {
    return "";
  }

  if (
    typeof choice.content === "string"
  ) {
    return choice.content.trim();
  }

  if (
    Array.isArray(choice.content)
  ) {
    return choice.content
      .map((part) => {
        if (
          typeof part === "string"
        ) {
          return part;
        }

        return part?.text || "";
      })
      .join("")
      .trim();
  }

  return "";
}

function extractSources(data) {
  const choice =
    data?.choices?.[0]?.message;

  if (!choice) {
    return [];
  }

  const annotations =
    Array.isArray(choice.annotations)
      ? choice.annotations
      : [];

  return annotations
    .map((annotation) => {
      return annotation?.url_citation;
    })
    .filter(Boolean)
    .map((citation) => ({
      title:
        citation.title ||
        citation.url ||
        "Source",

      url:
        citation.url
    }))
    .filter((source) => {
      return !!source.url;
    });
}

/* ---------------------------------------------------------
   MAIN API HANDLER
--------------------------------------------------------- */

module.exports = async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    return json(res, 405, {
      error: "Method not allowed."
    });
  }

  try {
    /* -----------------------------------------------
       CHECK OPENROUTER
    ------------------------------------------------ */

    if (!process.env.OPENROUTER_API_KEY) {
      return json(res, 500, {
        error:
          "OPENROUTER_API_KEY is missing in Vercel Environment Variables."
      });
    }

    /* -----------------------------------------------
       FIREBASE
    ------------------------------------------------ */

    const db = initFirebase();

    /* -----------------------------------------------
       FIREBASE AUTHENTICATION
    ------------------------------------------------ */

    const authHeader =
      req.headers.authorization || "";

    if (
      !authHeader.startsWith("Bearer ")
    ) {
      return json(res, 401, {
        error: "Authentication required."
      });
    }

    const token =
      authHeader
        .slice(7)
        .trim();

    if (!token) {
      return json(res, 401, {
        error:
          "Authentication token is missing."
      });
    }

    const decodedToken =
      await admin
        .auth()
        .verifyIdToken(token);

    const uid =
      decodedToken.uid;

    if (!uid) {
      return json(res, 401, {
        error:
          "Invalid authentication token."
      });
    }

    /* -----------------------------------------------
       REQUEST BODY
    ------------------------------------------------ */

    const body =
      req.body || {};

    const message =
      String(
        body.message || ""
      ).trim();

    const chatId =
      String(
        body.chatId || ""
      ).trim();

    let imageData =
      body.imageData ||
      null;

    const imageMime =
      normalizeImageMime(
        body.imageMime
      );

    if (imageData) {
      imageData =
        cleanBase64Image(
          imageData
        );
    }

    /* -----------------------------------------------
       EMPTY REQUEST CHECK
    ------------------------------------------------ */

    if (
      !message &&
      !imageData
    ) {
      return json(res, 400, {
        error:
          "Message is empty."
      });
    }

    /* -----------------------------------------------
       IMAGE SIZE CHECK
    ------------------------------------------------ */

    if (
      imageData &&
      imageData.length >
        20 * 1024 * 1024
    ) {
      return json(res, 413, {
        error:
          "Image is too large. Please choose a smaller image."
      });
    }

    /* -----------------------------------------------
       LOAD MEMORIES
    ------------------------------------------------ */

    const memoriesPromise =
      getMemories(
        db,
        uid
      );

    /* -----------------------------------------------
       LOAD CHAT HISTORY
    ------------------------------------------------ */

    let contextSnapshot =
      null;

    if (chatId) {
      contextSnapshot =
        await db
          .collection("users")
          .doc(uid)
          .collection("chats")
          .doc(chatId)
          .collection("messages")
          .orderBy(
            "createdAt",
            "desc"
          )
          .limit(18)
          .get();
    }

    const memories =
      await memoriesPromise;

    /* -----------------------------------------------
       FORMAT HISTORY
    ------------------------------------------------ */

    const history =
      contextSnapshot
        ? contextSnapshot.docs
            .reverse()
            .map((doc) => {
              return doc.data();
            })
            .filter((item) => {
              return (
                item.role === "user" ||
                item.role === "assistant"
              );
            })
        : [];

    /* -----------------------------------------------
       SYSTEM MESSAGE
    ------------------------------------------------ */

    const systemMessage = {
      role: "system",

      content:
        buildSystemPrompt(
          memories
        )
    };

    /* =================================================
       IMAGE ANALYSIS
    ================================================= */

    if (imageData) {
      const imagePrompt =
        message ||
        "Please analyze this image carefully. Describe what you can see, read any visible text, identify important details, and explain anything relevant.";

      const imageMessages = [
        systemMessage,

        ...history
          .slice(-8)
          .map((item) => ({
            role:
              item.role,

            content:
              String(
                item.content || ""
              ).slice(
                0,
                12000
              )
          })),

        {
          role: "user",

          content: [
            {
              type: "text",

              text:
                imagePrompt
            },

            {
              type: "image_url",

              image_url: {
                url:
                  `data:${imageMime};base64,${imageData}`
              }
            }
          ]
        }
      ];

      const data =
        await callOpenRouter({
          messages:
            imageMessages,

          model:
            VISION_MODEL,

          research:
            false
        });

      const text =
        extractAssistantText(
          data
        );

      if (!text) {
        return json(res, 502, {
          error:
            "The vision model did not return an image analysis."
        });
      }

      return json(res, 200, {
        text,

        model:
          data.model ||
          VISION_MODEL,

        sources: [],

        remembered: false
      });
    }

    /* =================================================
       NORMAL TEXT CHAT
    ================================================= */

    const textMessages = [
      systemMessage,

      ...history
        .slice(-12)
        .map((item) => ({
          role:
            item.role,

          content:
            String(
              item.content || ""
            ).slice(
              0,
              12000
            )
        })),

      {
        role: "user",

        content:
          message
      }
    ];

    /* -----------------------------------------------
       RESEARCH DETECTION
    ------------------------------------------------ */

    const research =
      shouldResearch(
        message
      );

    /* -----------------------------------------------
       CALL OPENROUTER
    ------------------------------------------------ */

    const data =
      await callOpenRouter({
        messages:
          textMessages,

        model:
          TEXT_MODEL,

        research
      });

    /* -----------------------------------------------
       GET RESPONSE
    ------------------------------------------------ */

    let text =
      extractAssistantText(
        data
      );

    if (!text) {
      text =
        "I could not generate a response.";
    }

    /* -----------------------------------------------
       SOURCES
    ------------------------------------------------ */

    const sources =
      extractSources(
        data
      );

    /* -----------------------------------------------
       SAVE MEMORY
    ------------------------------------------------ */

    const memory =
      extractMemory(
        message
      );

    if (memory) {
      try {
        await db
          .collection("users")
          .doc(uid)
          .collection("memories")
          .add({
            text:
              memory,

            createdAt:
              admin
                .firestore
                .FieldValue
                .serverTimestamp(),

            updatedAt:
              admin
                .firestore
                .FieldValue
                .serverTimestamp()
          });
      } catch (memoryError) {
        console.error(
          "Memory save error:",
          memoryError
        );
      }
    }

    /* -----------------------------------------------
       SUCCESS RESPONSE
    ------------------------------------------------ */

    return json(res, 200, {
      text,

      model:
        data.model ||
        TEXT_MODEL,

      sources,

      remembered:
        !!memory
    });

  } catch (error) {
    /* -----------------------------------------------
       ERROR HANDLING
    ------------------------------------------------ */

    console.error(
      "Nexus chat error:",
      error
    );

    const errorMessage =
      error?.message ||
      "Nexus AI is temporarily unavailable.";

    /* -----------------------------------------------
       FIREBASE AUTH ERROR
    ------------------------------------------------ */

    if (
      errorMessage.includes(
        "Firebase ID token"
      ) ||
      errorMessage.includes(
        "verifyIdToken"
      ) ||
      errorMessage.includes(
        "auth/id-token"
      )
    ) {
      return json(res, 401, {
        error:
          "Your login session has expired. Please sign in again."
      });
    }

    /* -----------------------------------------------
       OPENROUTER / MODEL ERROR
    ------------------------------------------------ */

    if (
      errorMessage.includes(
        "OpenRouter"
      ) ||
      errorMessage.includes(
        "model"
      ) ||
      errorMessage.includes(
        "endpoint"
      ) ||
      errorMessage.includes(
        "image input"
      )
    ) {
      return json(res, 502, {
        error:
          errorMessage
      });
    }

    /* -----------------------------------------------
       GENERAL ERROR
    ------------------------------------------------ */

    return json(res, 500, {
      error:
        errorMessage
    });
  }
};
