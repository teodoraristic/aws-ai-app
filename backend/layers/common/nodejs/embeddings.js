"use strict";

// Thin wrapper around Amazon Titan Text Embeddings v2.
//
// We use 256-dim normalized vectors:
//   - normalize=true means cosine similarity == dot product, but cosineSim()
//     stays generic in case a caller passes a non-normalized vector through.
//   - 256 dims keeps each consultation row well under 2KB while still being
//     plenty discriminative for short topic strings like "SQL joins" vs
//     "React hooks".
//
// Titan embed v2 in eu-west-1 is on-demand (no inference profile), so the
// modelId is the plain foundation-model id and the IAM policy just needs
// arn:aws:bedrock:eu-west-1::foundation-model/amazon.titan-embed-text-v2:0.

const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");

const client = new BedrockRuntimeClient({
  region: process.env.BEDROCK_REGION,
});

const EMBED_MODEL_ID =
  process.env.BEDROCK_EMBED_MODEL_ID || "amazon.titan-embed-text-v2:0";
const EMBED_DIMENSIONS = 256;

async function embedText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  const out = await client.send(
    new InvokeModelCommand({
      modelId: EMBED_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: trimmed,
        dimensions: EMBED_DIMENSIONS,
        normalize: true,
      }),
    })
  );

  const payload = JSON.parse(Buffer.from(out.body).toString("utf-8"));
  return Array.isArray(payload.embedding) ? payload.embedding : null;
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

module.exports = { embedText, cosineSim, EMBED_MODEL_ID };
