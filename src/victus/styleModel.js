// ─── Victus Style Model: real, small, honest ML ─────────────
//
// WHAT THIS IS: a contextual bandit. Two linear models (one scoring
// "concise" style, one scoring "detailed" style) predict expected user
// satisfaction (reward) from a small feature vector. Nova picks whichever
// style scores higher (with a little exploration), and after the user
// rates the reply, the CHOSEN model's weights are updated with a real
// gradient step based on the actual observed reward.
//
// This is genuinely different from Victus's memory layer (which just
// re-injects stored text into a prompt): here, numeric weights are
// updated by gradient descent from real feedback. That's real, if
// modest, machine learning.
//
// WHAT THIS IS NOT: a language model, a neural network, or anything
// close to "superintelligent." It's ~4 numbers per style, per user,
// updated with one of the oldest, most well-understood ML techniques
// (online linear regression / LMS). Small and honest beats impressive
// and false.

const db = require('../db');

const LEARNING_RATE = 0.1;
const EXPLORATION_RATE = 0.15; // ~15% of the time, try the other style anyway, so the model keeps learning instead of locking in early

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// Build a small, cheap-to-compute feature vector from the current message
// and conversation so far. Kept deliberately simple: this needs to be a
// couple of numbers extractable in milliseconds, not a heavy embedding.
function extractFeatures(userMessage, historyLength) {
  const lengthScore = Math.min(userMessage.length / 500, 1); // long question → mild signal toward detailed
  const looksTechnical = /\b(code|function|error|bug|api|debug|script|algorithm)\b/i.test(userMessage) ? 1 : 0;
  const isFollowUp = historyLength > 2 ? 1 : 0;
  const bias = 1;
  return [bias, lengthScore, looksTechnical, isFollowUp];
}

function dot(weights, features) {
  return weights.reduce((sum, w, i) => sum + w * (features[i] ?? 0), 0);
}

// Predict expected reward (mapped to roughly [-1, 1]) for a given style's
// weight vector against the current features.
function predictReward(weights, features) {
  return 2 * sigmoid(dot(weights, features)) - 1;
}

// Choose a style for this message: mostly greedy (pick the better-scoring
// style), occasionally exploratory (try the other one anyway) so the
// model isn't stuck forever if its early guess was wrong.
async function chooseStyle(userId, userMessage, historyLength) {
  if (!db.isEnabled() || !userId) {
    return { style: 'balanced', features: null, predictedValue: null };
  }

  const features = extractFeatures(userMessage, historyLength);
  const weights = await db.getStyleModel(userId);

  const conciseScore = predictReward(weights.concise, features);
  const detailedScore = predictReward(weights.detailed, features);

  let style = conciseScore >= detailedScore ? 'concise' : 'detailed';
  if (Math.random() < EXPLORATION_RATE) {
    style = style === 'concise' ? 'detailed' : 'concise';
  }

  const predictedValue = style === 'concise' ? conciseScore : detailedScore;
  return { style, features, predictedValue };
}

// Turn the chosen style into an actual instruction the model can follow.
function styleInstruction(style) {
  if (style === 'concise') return 'Keep this response short and to the point — a few sentences, no padding.';
  if (style === 'detailed') return 'Give a thorough, well-explained response with enough detail to be genuinely useful.';
  return '';
}

// Record which style was used for a given assistant message, so a later
// rating can be traced back to the exact features/style that earned it.
async function recordPrediction(messageId, userId, features, style, predictedValue) {
  if (!db.isEnabled() || !userId || !features) return;
  await db.savePrediction(messageId, userId, features, style, predictedValue);
}

// The actual learning step: given a real rating on a real past prediction,
// nudge that style's weights toward better predicting this outcome.
// This is a single step of online gradient descent on squared error
// between predicted and observed reward — genuinely real ML, just small.
async function learnFromRating(messageId, userId, rating) {
  if (!db.isEnabled() || !userId) return { updated: false };

  const prediction = await db.getPrediction(messageId);
  if (!prediction) return { updated: false, reason: 'No prediction on record for this message' };

  const features = prediction.features;
  const style = prediction.style;
  const observedReward = rating; // rating is already -1 or 1

  const weights = await db.getStyleModel(userId);
  const w = weights[style] || [0, 0, 0, 0];

  const predicted = predictReward(w, features);
  const error = observedReward - predicted;

  // Gradient step for w·x passed through sigmoid: standard online update.
  const updated = w.map((wi, i) => wi + LEARNING_RATE * error * (features[i] ?? 0));
  weights[style] = updated;

  await db.saveStyleModel(userId, weights);
  return { updated: true, style, previousPrediction: predicted, newWeights: updated };
}

module.exports = { chooseStyle, styleInstruction, recordPrediction, learnFromRating };
