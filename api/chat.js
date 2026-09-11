const admin = require("firebase-admin");

/*
 * ============================================================
 * NEXUS AI — FREE CHAT + FREE IMAGE ANALYSIS
 * ============================================================
 *
 * IMPORTANT:
 * - Uses OpenRouter's free router.
 * - Normal text chat: openrouter/free
 * - Image analysis: openrouter/free
 * - No paid Gemini model is forced here.
 * - OpenRouter API key stays on the server.
 * - Firebase Admin credentials stay on the server.
 *
 * Do NOT put OPENROUTER_API_KEY in index.html.
 * ============================================================
 */

const MODEL = "openrouter/free";
const VISION_MODEL = "openrouter/free";


// ------------------------------------------------------------
// FIREBASE ADMIN
// ------------------------------------------------------------

function initFirebase() {
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    throw new Error(
      "Firebase server configuration is missing."
    );
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,

        clientEmail:
          process.env.FIREBASE_CLIENT_EMAIL,

        privateKey:
          process.env.FIREBASE_PRIVATE_KEY.replace(
            /\\n/g,
            "\n"
          )
      })
    });
  }

  return admin.firestore();
}


// ------------------------------------------------------------
// JSON RESPONSE
// ------------------------------------------------------------

function json(res, status, body) {
  return res.status(status).json(body);
}


// ------------------------------------------------------------
// MEMORY DETECTION
// ------------------------------------------------------------

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
      return match[1]
        .trim()
        .slice(0, 1000);
    }
  }

  return null;
}


// ------------------------------------------------------------
// GET LONG-TERM MEMORIES
// ------------------------------------------------------------

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
      "Memory read error:",
      error?.message
    );

    return [];
  }
}


// ------------------------------------------------------------
// SYSTEM PROMPT
// ------------------------------------------------------------

function buildSystem(memories) {
  return `
You are Nexus AI, a highly capable global AI assistant.

Your job is to be:
- helpful
- accurate
- clear
- practical
- honest about uncertainty
- concise when appropriate
- detailed when the user needs detail

Do not claim to have capabilities you do not have.

You can:
- answer questions
- analyze uploaded images
- read text from images
- explain screenshots
- help debug code
- write and edit code
- solve calculations
- help with writing
- research information
- summarize information
- create plans
- teach concepts
- help users make decisions

IMAGE ANALYSIS:
When an image is supplied, actually analyze the image contents.
Describe visible objects, text, layout, errors, screenshots, diagrams,
or other relevant visual information when possible.

If the image contains text, try to read and explain the text.

If the image is unclear or unreadable, say what is unclear instead
of pretending you can see something that is not visible.

CURRENT INFORMATION:
For questions involving current, recent, changing, or research
information, use web search when available.

Do not invent sources or URLs.

If sources are returned by the system, use them naturally.

MEMORY:
The user may explicitly ask you to remember something.
The saved memories below can be used naturally.

LONG-TERM MEMORIES:

${
  memories.length
    ? memories
        .map(memory => "- " + memory)
        .join("\n")
    : "(none saved)"
}
`;
}


// ------------------------------------------------------------
// DETECT RESEARCH QUESTIONS
// ------------------------------------------------------------

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
    source|
    sources|
    price|
    prices|
    weather|
    market|
    2026|
    this\s+week|
    this\s+month
  )\b/ix.test(text || "");
}


// ------------------------------------------------------------
// OPENROUTER REQUEST
// ------------------------------------------------------------

async function callOpenRouter({
  messages,
  research = false,
  model
}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is missing from Vercel environment variables."
    );
  }

  const body = {
    model: model || MODEL,

    messages,

    temperature: 0.2
  };


  /*
   * OpenRouter's web plugin is used for research/current questions.
   */
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
    const message =
      data?.error?.message ||
      data?.error?.code ||
      `OpenRouter returned HTTP ${response.status}`;

    const error = new Error(message);

    error.status =
      response.status;

    error.openRouterData =
      data;

    throw error;
  }


  return data;
}


// ------------------------------------------------------------
// EXTRACT ASSISTANT TEXT
// ------------------------------------------------------------

function extractAssistantText(choice) {
  if (!choice) {
    return "";
  }


  if (
    typeof choice.content ===
    "string"
  ) {
    return choice.content;
  }


  if (
    Array.isArray(choice.content)
  ) {
    return choice.content
      .map(part => {
        if (
          typeof part === "string"
        ) {
          return part;
        }

        return part?.text || "";
      })
      .join("");
  }


  return "";
}


// ------------------------------------------------------------
// EXTRACT SOURCES
// ------------------------------------------------------------

function extractSources(choice, data) {
  const sources = [];


  /*
   * Some OpenRouter responses put citations
   * in message annotations.
   */

  const annotations =
    choice?.annotations || [];


  for (const annotation of annotations) {
    const citation =
      annotation?.url_citation;

    if (
      citation?.url
    ) {
      sources.push({
        title:
          citation.title ||
          citation.url,

        url:
          citation.url
      });
    }
  }


  /*
   * Also support common provider/web response
   * citation structures.
   */

  const dataSources =
    data?.sources ||
    data?.citations ||
    data?.web?.sources ||
    [];


  if (Array.isArray(dataSources)) {
    for (const source of dataSources) {
      const url =
        source?.url ||
        source?.link;

      if (url) {
        sources.push({
          title:
            source?.title ||
            source?.name ||
            url,

          url
        });
      }
    }
  }


  /*
   * Remove duplicate URLs.
   */

  const unique = [];
  const seen = new Set();

  for (const source of sources) {
    if (
      source.url &&
      !seen.has(source.url)
    ) {
      seen.add(source.url);
      unique.push(source);
    }
  }


  return unique.slice(0, 10);
}


// ------------------------------------------------------------
// MAIN HANDLER
// ------------------------------------------------------------

module.exports = async function handler(
  req,
  res
) {
  /*
   * ----------------------------------------------------------
   * METHOD CHECK
   * ----------------------------------------------------------
   */

  if (req.method !== "POST") {
    return json(res, 405, {
      error:
        "Method not allowed."
    });
  }


  try {
    /*
     * --------------------------------------------------------
     * OPENROUTER KEY CHECK
     * --------------------------------------------------------
     */

    if (
      !process.env.OPENROUTER_API_KEY
    ) {
      return json(res, 500, {
        error:
          "OPENROUTER_API_KEY is missing in Vercel."
      });
    }


    /*
     * --------------------------------------------------------
     * FIREBASE
     * --------------------------------------------------------
     */

    const db =
      initFirebase();


    /*
     * --------------------------------------------------------
     * FIREBASE AUTH
     * --------------------------------------------------------
     */

    const authHeader =
      req.headers.authorization ||
      "";


    if (
      !authHeader.startsWith(
        "Bearer "
      )
    ) {
      return json(res, 401, {
        error:
          "Authentication required."
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


    let decoded;


    try {
      decoded =
        await admin
          .auth()
          .verifyIdToken(token);
    } catch (authError) {
      console.error(
        "Firebase token error:",
        authError?.message
      );

      return json(res, 401, {
        error:
          "Your login session is invalid or expired. Please sign in again."
      });
    }


    const uid =
      decoded.uid;


    /*
     * --------------------------------------------------------
     * REQUEST DATA
     * --------------------------------------------------------
     */

    const message =
      String(
        req.body?.message ||
        ""
      ).trim();


    const chatId =
      String(
        req.body?.chatId ||
        ""
      ).trim();


    /*
     * Image sent from the frontend
     * as base64 without the data: prefix.
     */

    const imageData =
      req.body?.imageData ||
      null;


    const imageMime =
      String(
        req.body?.imageMime ||
        "image/jpeg"
      );


    /*
     * --------------------------------------------------------
     * VALIDATE MESSAGE
     * --------------------------------------------------------
     */

    if (
      !message &&
      !imageData
    ) {
      return json(res, 400, {
        error:
          "Message is empty."
      });
    }


    /*
     * --------------------------------------------------------
     * LOAD MEMORIES + CHAT HISTORY
     * --------------------------------------------------------
     */

    const memoriesPromise =
      getMemories(
        db,
        uid
      );


    let contextPromise =
      null;


    if (chatId) {
      contextPromise =
        db
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


    const [
      memories,
      contextSnapshot
    ] = await Promise.all([
      memoriesPromise,
      contextPromise
    ]);


    /*
     * --------------------------------------------------------
     * BUILD CHAT HISTORY
     * --------------------------------------------------------
     */

    const history =
      contextSnapshot
        ? contextSnapshot.docs
            .reverse()
            .map(doc =>
              doc.data()
            )
            .filter(item =>
              item?.role === "user" ||
              item?.role === "assistant"
            )
        : [];


    /*
     * --------------------------------------------------------
     * BUILD USER CONTENT
     * --------------------------------------------------------
     */

    const userContent = [];


    if (message) {
      userContent.push({
        type: "text",
        text: message
      });
    }


    /*
     * --------------------------------------------------------
     * IMAGE CONTENT
     * --------------------------------------------------------
     */

    if (imageData) {
      userContent.push({
        type: "image_url",

        image_url: {
          url:
            `data:${imageMime};base64,${imageData}`
        }
      });
    }


    /*
     * --------------------------------------------------------
     * BUILD OPENROUTER MESSAGES
     * --------------------------------------------------------
     */

    const messages = [
      {
        role: "system",

        content:
          buildSystem(memories)
      },


      /*
       * Keep recent history reasonably small.
       */

      ...history
        .slice(-12)
        .map(item => ({
          role:
            item.role,

          content:
            String(
              item.content ||
              ""
            ).slice(0, 12000)
        })),


      /*
       * Current user request.
       */

      {
        role: "user",

        content:
          imageData
            ? userContent
            : message
      }
    ];


    /*
     * --------------------------------------------------------
     * RESEARCH DETECTION
     * --------------------------------------------------------
     */

    const research =
      shouldResearch(
        message
      );


    /*
     * --------------------------------------------------------
     * SELECT MODEL
     * --------------------------------------------------------
     *
     * IMPORTANT:
     * Both are deliberately hard-coded to
     * openrouter/free.
     *
     * This prevents an old Vercel
     * NEXUS_VISION_MODEL environment variable
     * from accidentally selecting a paid model.
     * --------------------------------------------------------
     */

    const selectedModel =
      imageData
        ? VISION_MODEL
        : MODEL;


    /*
     * --------------------------------------------------------
     * CALL OPENROUTER
     * --------------------------------------------------------
     */

    let data;


    try {
      data =
        await callOpenRouter({
          messages,

          research,

          model:
            selectedModel
        });
    } catch (firstError) {

      /*
       * ------------------------------------------------------
       * RESEARCH FALLBACK
       * ------------------------------------------------------
       *
       * If the free model/provider cannot handle the
       * web plugin request, retry once without the
       * research plugin.
       *
       * This keeps normal chat working instead of
       * showing an unnecessary failure.
       * ------------------------------------------------------
       */

      if (research) {
        console.error(
          "Research request failed; retrying without web plugin:",
          firstError?.message
        );

        try {
          data =
            await callOpenRouter({
              messages,

              research: false,

              model:
                selectedModel
            });
        } catch (secondError) {
          throw secondError;
        }
      } else {
        throw firstError;
      }
    }


    /*
     * --------------------------------------------------------
     * GET RESPONSE
     * --------------------------------------------------------
     */

    const choice =
      data?.choices?.[0]?.message ||
      {};


    let text =
      extractAssistantText(
        choice
      );


    /*
     * --------------------------------------------------------
     * EMPTY RESPONSE PROTECTION
     * --------------------------------------------------------
     */

    if (!text) {
      text =
        "I could not generate a response right now. Please try again.";
    }


    /*
     * --------------------------------------------------------
     * SOURCES
     * --------------------------------------------------------
     */

    const sources =
      extractSources(
        choice,
        data
      );


    /*
     * --------------------------------------------------------
     * SAVE EXPLICIT MEMORY
     * --------------------------------------------------------
     */

    const memory =
      extractMemories(
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
              admin.firestore
                .FieldValue
                .serverTimestamp(),

            updatedAt:
              admin.firestore
                .FieldValue
                .serverTimestamp()
          });
      } catch (memoryError) {
        /*
         * Memory failure should NOT break the
         * actual AI response.
         */

        console.error(
          "Memory save error:",
          memoryError?.message
        );
      }
    }


    /*
     * --------------------------------------------------------
     * SUCCESS
     * --------------------------------------------------------
     */

    return json(res, 200, {
      text,

      /*
       * This is the actual model returned by OpenRouter.
       */

      model:
        data?.model ||
        selectedModel,

      sources,

      remembered:
        Boolean(memory),

      hasImage:
        Boolean(imageData)
    });


  } catch (error) {

    /*
     * --------------------------------------------------------
     * ERROR HANDLING
     * --------------------------------------------------------
     */

    console.error(
      "Nexus chat error:",
      error
    );


    const message =
      error?.message ||
      "Nexus AI is temporarily unavailable.";


    /*
     * OpenRouter quota / credits errors.
     */

    if (
      /insufficient credits/i.test(
        message
      ) ||
      /credits/i.test(
        message
      ) ||
      /quota/i.test(
        message
      ) ||
      /payment/i.test(
        message
      )
    ) {
      return json(res, 503, {
        error:
          "The free AI provider is temporarily unavailable. Please try again later."
      });
    }


    /*
     * Image endpoint problems.
     */

    if (
      /image input/i.test(
        message
      ) ||
      /vision/i.test(
        message
      ) ||
      /multimodal/i.test(
        message
      )
    ) {
      return json(res, 503, {
        error:
          "The free image-analysis model is temporarily unavailable. Please try the image again."
      });
    }


    /*
     * General error.
     */

    return json(res, 500, {
      error:
        message
    });
  }
};
