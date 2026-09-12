const admin = require("firebase-admin");

/*
|--------------------------------------------------------------------------
| Firebase Admin
|--------------------------------------------------------------------------
*/

if (!admin.apps.length) {
  const privateKey = String(
    process.env.FIREBASE_PRIVATE_KEY || ""
  ).replace(/\\n/g, "\n");

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    })
  });
}

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function sendJson(res, status, data) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  return res.end(JSON.stringify(data));
}

function getBearerToken(req) {
  const authorization = String(
    req.headers.authorization || ""
  );

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.substring(7).trim();
}

function getPrompt(req) {
  return String(
    req.body?.prompt || ""
  ).trim().slice(0, 4000);
}

function validAspectRatio(value) {
  const allowed = [
    "1:1",
    "16:9",
    "9:16",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "4:5",
    "5:4"
  ];

  return allowed.includes(value)
    ? value
    : "1:1";
}

function validResolution(value) {
  const allowed = [
    "1K",
    "2K",
    "4K"
  ];

  return allowed.includes(value)
    ? value
    : "1K";
}

/*
|--------------------------------------------------------------------------
| API
|--------------------------------------------------------------------------
*/

module.exports = async function handler(req, res) {

  /*
  |--------------------------------------------------------------------------
  | Method
  |--------------------------------------------------------------------------
  */

  if (req.method !== "POST") {
    return sendJson(res, 405, {
      available: false,
      error: "Method not allowed. Use POST."
    });
  }

  try {

    /*
    |--------------------------------------------------------------------------
    | Firebase Authentication
    |--------------------------------------------------------------------------
    */

    const token = getBearerToken(req);

    if (!token) {
      return sendJson(res, 401, {
        available: false,
        error: "Please sign in before generating an image."
      });
    }

    let user;

    try {

      user =
        await admin
          .auth()
          .verifyIdToken(token);

    } catch (authError) {

      console.error(
        "Firebase authentication error:",
        authError
      );

      return sendJson(res, 401, {
        available: false,
        error: "Your login session is invalid or expired."
      });
    }

    if (!user || !user.uid) {
      return sendJson(res, 401, {
        available: false,
        error: "Authentication failed."
      });
    }

    /*
    |--------------------------------------------------------------------------
    | Prompt
    |--------------------------------------------------------------------------
    */

    const prompt = getPrompt(req);

    if (!prompt) {
      return sendJson(res, 400, {
        available: false,
        error: "Please describe the image you want."
      });
    }

    /*
    |--------------------------------------------------------------------------
    | Cloudinary Environment Variables
    |--------------------------------------------------------------------------
    */

    const cloudName =
      process.env.CLOUDINARY_CLOUD_NAME;

    const apiKey =
      process.env.CLOUDINARY_API_KEY;

    const apiSecret =
      process.env.CLOUDINARY_API_SECRET;

    if (!cloudName) {
      console.error(
        "Missing CLOUDINARY_CLOUD_NAME"
      );

      return sendJson(res, 500, {
        available: false,
        error:
          "Cloudinary cloud name is not configured."
      });
    }

    if (!apiKey) {
      console.error(
        "Missing CLOUDINARY_API_KEY"
      );

      return sendJson(res, 500, {
        available: false,
        error:
          "Cloudinary API key is not configured."
      });
    }

    if (!apiSecret) {
      console.error(
        "Missing CLOUDINARY_API_SECRET"
      );

      return sendJson(res, 500, {
        available: false,
        error:
          "Cloudinary API secret is not configured."
      });
    }

    /*
    |--------------------------------------------------------------------------
    | Image Settings
    |--------------------------------------------------------------------------
    */

    const aspectRatio =
      validAspectRatio(
        String(
          req.body?.aspectRatio || "1:1"
        )
      );

    const resolution =
      validResolution(
        String(
          req.body?.resolution || "1K"
        )
      );

    /*
    |--------------------------------------------------------------------------
    | Cloudinary Image Generation Request
    |--------------------------------------------------------------------------
    |
    | nano-banana + premium = Nano Banana 2
    |
    */

    const payload = {
      prompt,

      model: {
        family: "nano-banana",
        tier: "premium"
      },

      image_size: {
        aspect_ratio: aspectRatio,
        resolution
      },

      format: "png",

      target: {
        target_type: "managed_asset"
      }
    };

    /*
    |--------------------------------------------------------------------------
    | Basic Authentication
    |--------------------------------------------------------------------------
    */

    const basicAuth = Buffer
      .from(
        `${apiKey}:${apiSecret}`
      )
      .toString("base64");

    /*
    |--------------------------------------------------------------------------
    | Abort Timeout
    |--------------------------------------------------------------------------
    */

    const controller =
      new AbortController();

    const timeout =
      setTimeout(() => {
        controller.abort();
      }, 120000);

    let cloudinaryResponse;

    try {

      cloudinaryResponse =
        await fetch(
          `https://api.cloudinary.com/v2/generate/${encodeURIComponent(
            cloudName
          )}/text_to_image`,
          {
            method: "POST",

            headers: {
              "Authorization":
                `Basic ${basicAuth}`,

              "Content-Type":
                "application/json",

              "Accept":
                "application/json"
            },

            body:
              JSON.stringify(payload),

            signal:
              controller.signal
          }
        );

    } finally {

      clearTimeout(timeout);

    }

    /*
    |--------------------------------------------------------------------------
    | Read Cloudinary Response
    |--------------------------------------------------------------------------
    */

    const responseText =
      await cloudinaryResponse.text();

    let cloudinaryData = {};

    try {

      cloudinaryData =
        responseText
          ? JSON.parse(responseText)
          : {};

    } catch {

      cloudinaryData = {
        raw: responseText
      };

    }

    /*
    |--------------------------------------------------------------------------
    | Cloudinary Error
    |--------------------------------------------------------------------------
    */

    if (!cloudinaryResponse.ok) {

      console.error(
        "Cloudinary generation failed:",
        cloudinaryResponse.status,
        cloudinaryData
      );

      let errorMessage =
        "Cloudinary image generation failed.";

      if (
        cloudinaryData?.error?.message
      ) {

        errorMessage =
          cloudinaryData.error.message;

      } else if (
        typeof cloudinaryData?.error ===
        "string"
      ) {

        errorMessage =
          cloudinaryData.error;

      } else if (
        cloudinaryData?.message
      ) {

        errorMessage =
          cloudinaryData.message;

      } else if (
        typeof cloudinaryData?.raw ===
        "string"
      ) {

        errorMessage =
          cloudinaryData.raw.slice(
            0,
            800
          );

      }

      return sendJson(
        res,
        cloudinaryResponse.status >= 400 &&
        cloudinaryResponse.status < 600
          ? cloudinaryResponse.status
          : 502,
        {
          available: false,
          error: errorMessage
        }
      );
    }

    /*
    |--------------------------------------------------------------------------
    | Find Generated Asset
    |--------------------------------------------------------------------------
    */

    const asset =
      cloudinaryData?.data?.assets?.[0] ||
      cloudinaryData?.assets?.[0] ||
      null;

    if (!asset) {

      console.error(
        "Cloudinary returned no asset:",
        cloudinaryData
      );

      return sendJson(res, 502, {
        available: false,
        error:
          "Cloudinary did not return a generated image."
      });
    }

    /*
    |--------------------------------------------------------------------------
    | Find Secure URL
    |--------------------------------------------------------------------------
    */

    const imageUrl =
      asset?.storage?.secure_url ||
      asset?.secure_url ||
      asset?.url ||
      cloudinaryData?.secure_url ||
      cloudinaryData?.image_url ||
      cloudinaryData?.url ||
      null;

    if (!imageUrl) {

      console.error(
        "Cloudinary asset has no URL:",
        asset
      );

      return sendJson(res, 502, {
        available: false,
        error:
          "The image was generated, but Cloudinary did not return an image URL."
      });
    }

    /*
    |--------------------------------------------------------------------------
    | Success
    |--------------------------------------------------------------------------
    */

    console.log(
      "Image generated successfully:",
      {
        uid: user.uid,
        model:
          asset?.model_id ||
          asset?.model ||
          "nano-banana-2",
        aspectRatio,
        resolution
      }
    );

    return sendJson(res, 200, {

      available: true,

      success: true,

      /*
      | Main field used by NexusMind frontend
      */
      imageUrl,

      /*
      | Compatibility fields
      */
      image: imageUrl,
      url: imageUrl,
      secure_url: imageUrl,

      /*
      | Model
      */
      model:
        asset?.model_id ||
        asset?.model ||
        "nano-banana-2",

      provider:
        "cloudinary",

      /*
      | Cloudinary asset information
      */
      publicId:
        asset?.public_id ||
        null,

      assetId:
        asset?.asset_id ||
        null,

      width:
        asset?.width ||
        null,

      height:
        asset?.height ||
        null,

      format:
        asset?.format ||
        "png",

      /*
      | Request information
      */
      aspectRatio,
      resolution,

      /*
      | Useful for Firestore history
      */
      prompt

    });

  } catch (error) {

    console.error(
      "NexusMind /api/image error:",
      error
    );

    /*
    |--------------------------------------------------------------------------
    | Timeout
    |--------------------------------------------------------------------------
    */

    if (
      error?.name ===
      "AbortError"
    ) {

      return sendJson(res, 504, {
        available: false,
        error:
          "Image generation timed out. Please try again."
      });
    }

    /*
    |--------------------------------------------------------------------------
    | General Error
    |--------------------------------------------------------------------------
    */

    return sendJson(res, 500, {
      available: false,
      error:
        error?.message ||
        "Image generation failed. Please try again."
    });
  }
};
