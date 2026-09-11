const admin = require('firebase-admin');

/*
 * ---------------------------------------------------------
 * Firebase
 * ---------------------------------------------------------
 */

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

/*
 * ---------------------------------------------------------
 * Cloudinary configuration
 * ---------------------------------------------------------
 */

function getCloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      'Cloudinary configuration is missing. Required environment variables: ' +
      'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.'
    );
  }

  return {
    cloudName,
    apiKey,
    apiSecret
  };
}

/*
 * ---------------------------------------------------------
 * Image settings
 * ---------------------------------------------------------
 *
 * The frontend can send:
 *
 * size:
 *   1024x1024
 *   1536x1024
 *   1024x1536
 *   1792x1024
 *   1024x1792
 *
 * aspectRatio can also be sent directly.
 */

function getImageSettings(body) {
  const requestedSize = String(
    body?.size || ''
  ).trim();

  let aspectRatio =
    String(
      body?.aspectRatio ||
      body?.aspect_ratio ||
      ''
    ).trim();

  if (!aspectRatio) {
    if (
      requestedSize === '1536x1024' ||
      requestedSize === '1792x1024' ||
      requestedSize === '16:9'
    ) {
      aspectRatio = '16:9';
    } else if (
      requestedSize === '1024x1536' ||
      requestedSize === '1024x1792' ||
      requestedSize === '9:16'
    ) {
      aspectRatio = '9:16';
    } else if (
      requestedSize === '1024x1280' ||
      requestedSize === '4:5'
    ) {
      aspectRatio = '4:5';
    } else if (
      requestedSize === '1280x1024' ||
      requestedSize === '5:4'
    ) {
      aspectRatio = '5:4';
    } else if (
      requestedSize === '1536x1536' ||
      requestedSize === '1:1'
    ) {
      aspectRatio = '1:1';
    } else {
      aspectRatio = '1:1';
    }
  }

  const allowedRatios = [
    '1:1',
    '16:9',
    '9:16',
    '4:5',
    '5:4',
    '4:3',
    '3:4',
    '3:2',
    '2:3'
  ];

  if (!allowedRatios.includes(aspectRatio)) {
    aspectRatio = '1:1';
  }

  const requestedResolution = String(
    body?.resolution || ''
  ).toUpperCase();

  const quality = String(
    body?.quality || ''
  ).toLowerCase();

  let resolution = '1K';

  if (
    requestedResolution === '2K' ||
    quality === 'high' ||
    quality === 'hd' ||
    quality === 'premium'
  ) {
    resolution = '2K';
  }

  return {
    aspectRatio,
    resolution
  };
}

/*
 * ---------------------------------------------------------
 * Cloudinary model
 * ---------------------------------------------------------
 *
 * Default:
 *
 * family = nano-banana
 * tier   = premium
 *
 * Cloudinary's current model registry resolves this to
 * nano-banana-2.
 *
 * You can also set:
 *
 * NEXUS_CLOUDINARY_IMAGE_MODEL_ID=nano-banana-2
 *
 * in Vercel if you want to pin the exact model.
 */

function getModel() {
  const exactModelId =
    String(
      process.env.NEXUS_CLOUDINARY_IMAGE_MODEL_ID || ''
    ).trim();

  if (exactModelId) {
    return {
      id: exactModelId
    };
  }

  return {
    family:
      process.env.NEXUS_CLOUDINARY_IMAGE_FAMILY ||
      'nano-banana',

    tier:
      process.env.NEXUS_CLOUDINARY_IMAGE_TIER ||
      'premium'
  };
}

/*
 * ---------------------------------------------------------
 * Main handler
 * ---------------------------------------------------------
 */

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed.'
    });
  }

  try {
    /*
     * Firebase authentication
     */

    initFirebase();

    const authHeader =
      req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required.'
      });
    }

    const idToken =
      authHeader
        .slice(7)
        .trim();

    if (!idToken) {
      return res.status(401).json({
        error: 'Authentication token is missing.'
      });
    }

    await admin
      .auth()
      .verifyIdToken(idToken);

    /*
     * Get user's image prompt
     */

    const prompt =
      String(
        req.body?.prompt || ''
      ).trim();

    if (!prompt) {
      return res.status(400).json({
        error: 'Image prompt is empty.'
      });
    }

    /*
     * Cloudinary credentials
     */

    const {
      cloudName,
      apiKey,
      apiSecret
    } = getCloudinaryConfig();

    /*
     * Image settings
     */

    const {
      aspectRatio,
      resolution
    } = getImageSettings(
      req.body || {}
    );

    /*
     * Model
     */

    const model = getModel();

    /*
     * Optional reference images.
     *
     * The normal text-to-image request does not need them.
     *
     * If references are supplied, they must be Cloudinary
     * managed assets or HTTPS URLs supported by Cloudinary.
     */

    const referenceImages =
      Array.isArray(
        req.body?.reference_images
      )
        ? req.body.reference_images.slice(0, 4)
        : [];

    /*
     * -------------------------------------------------------
     * Build Cloudinary request
     * -------------------------------------------------------
     */

    const body = {
      prompt,

      model,

      image_size: {
        aspect_ratio: aspectRatio,
        resolution
      },

      format: 'png',

      target: {
        target_type: 'managed_asset'
      }
    };

    /*
     * If reference images were provided, use Cloudinary's
     * image_to_image endpoint.
     *
     * Otherwise use text_to_image.
     */

    let endpoint =
      `https://api.cloudinary.com/v2/generate/${encodeURIComponent(
        cloudName
      )}/text_to_image`;

    if (referenceImages.length > 0) {
      body.reference_images =
        referenceImages.map((item) => {
          if (
            typeof item === 'string'
          ) {
            return {
              source_type: 'url',
              url: item
            };
          }

          if (
            item &&
            typeof item === 'object'
          ) {
            if (item.asset_id) {
              return {
                source_type: 'managed_asset',
                asset_id: String(
                  item.asset_id
                )
              };
            }

            if (item.url) {
              return {
                source_type: 'url',
                url: String(
                  item.url
                )
              };
            }
          }

          return null;
        }).filter(Boolean);

      if (body.reference_images.length > 0) {
        endpoint =
          `https://api.cloudinary.com/v2/generate/${encodeURIComponent(
            cloudName
          )}/image_to_image`;
      }
    }

    /*
     * -------------------------------------------------------
     * Cloudinary Basic Authentication
     * -------------------------------------------------------
     */

    const auth =
      Buffer
        .from(
          `${apiKey}:${apiSecret}`
        )
        .toString('base64');

    /*
     * -------------------------------------------------------
     * Generate image
     * -------------------------------------------------------
     */

    const response =
      await fetch(
        endpoint,
        {
          method: 'POST',

          headers: {
            Authorization:
              `Basic ${auth}`,

            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify(body)
        }
      );

    const raw =
      await response.text();

    let data = {};

    try {
      data =
        JSON.parse(raw);
    } catch {
      data = {};
    }

    /*
     * -------------------------------------------------------
     * Cloudinary error handling
     * -------------------------------------------------------
     */

    if (!response.ok) {
      console.error(
        'Cloudinary image generation error:',
        response.status,
        raw
      );

      const message =
        data?.error?.message ||
        data?.message ||
        `Cloudinary image generation failed (HTTP ${response.status}).`;

      const lower =
        String(message)
          .toLowerCase();

      const noCredits =
        response.status === 402 ||
        lower.includes('credit') ||
        lower.includes('quota') ||
        lower.includes('billing') ||
        lower.includes('payment') ||
        lower.includes('limit') ||
        lower.includes('balance');

      if (noCredits) {
        return res.status(200).json({
          available: false,

          error:
            'Image generation is currently unavailable because your Cloudinary Image Generation credits or quota have been exhausted.'
        });
      }

      return res.status(502).json({
        available: false,

        error:
          message
      });
    }

    /*
     * -------------------------------------------------------
     * Extract generated asset
     * -------------------------------------------------------
     */

    const asset =
      data?.data?.assets?.[0] ||
      data?.assets?.[0];

    const imageUrl =
      asset?.storage?.secure_url ||
      asset?.secure_url ||
      asset?.delivery?.secure_url;

    /*
     * Cloudinary sometimes returns a successful response
     * without a usable asset URL.
     */

    if (!imageUrl) {
      console.error(
        'Cloudinary returned no image URL:',
        JSON.stringify(data)
      );

      return res.status(502).json({
        available: false,

        error:
          'Cloudinary completed the generation but did not return a usable image URL.'
      });
    }

    /*
     * -------------------------------------------------------
     * Success
     * -------------------------------------------------------
     */

    return res.status(200).json({
      available: true,

      image: imageUrl,

      imageUrl: imageUrl,

      url: imageUrl,

      provider: 'cloudinary',

      model:
        asset?.context?.custom?.model_id ||
        asset?.context?.custom?.model ||
        asset?.public_id ||
        (
          model.id ||
          `${model.family}:${model.tier}`
        ),

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
        'png',

      prompt,

      aspectRatio,

      resolution
    });

  } catch (error) {
    console.error(
      'Nexus Cloudinary image error:',
      error
    );

    return res.status(500).json({
      available: false,

      error:
        error?.message ||
        'Image generation failed.'
    });
  }
};
