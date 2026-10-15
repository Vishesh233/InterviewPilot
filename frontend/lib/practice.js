// In-memory practice session for the read-only demo kits. Mirrors the
// backend's practiceService ordering and progress so the demo behaves like a
// real kit; nothing is sent anywhere and a reload starts from the snapshot.

// Next session order: uncovered first, unrated first, then lower confidence,
// ties in deck order.
const sortKey = (item) => [
  item.practice.covered ? 1 : 0,
  item.practice.confidence === null ? 0 : 1,
  item.practice.confidence === null ? 0 : item.practice.confidence,
  item.index,
];

const compare = (a, b) => {
  const keyA = sortKey(a);
  const keyB = sortKey(b);
  for (let i = 0; i < keyA.length; i += 1) if (keyA[i] !== keyB[i]) return keyA[i] < keyB[i] ? -1 : 1;
  return 0;
};

const practiceOf = (card) => ({
  confidence: Number.isInteger(card?.practice?.confidence) ? card.practice.confidence : null,
  covered: card?.practice?.covered === true,
  lastReviewedAt: card?.practice?.lastReviewedAt || null,
});

export function buildPracticeItems(cards) {
  return cards
    .map((card, index) => ({ flashcard: { id: card.id, front: card.front || '', back: card.back || '', questionIds: card.questionIds || [] }, practice: practiceOf(card), index }))
    .sort(compare)
    .map(({ flashcard, practice }) => ({ flashcard, practice }));
}

export function computeProgress(items) {
  const total = items.length;
  const covered = items.filter((item) => item.practice.covered).length;
  const ratings = items.map((item) => item.practice.confidence).filter((value) => Number.isInteger(value));
  return {
    total,
    covered,
    uncovered: total - covered,
    rated: ratings.length,
    unrated: total - ratings.length,
    averageConfidence: ratings.length ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 100) / 100 : null,
  };
}

// A practice source over a mutable copy of the deck: { load, update }, the
// same contract PracticeMode uses for the API.
export function createMemoryPracticeSource(flashcards) {
  const cards = flashcards.map((card) => ({ ...card, practice: practiceOf(card) }));
  return {
    load: async () => {
      const items = buildPracticeItems(cards);
      return { items, progress: computeProgress(items) };
    },
    update: async (flashcardId, changes) => {
      const card = cards.find((item) => item.id === flashcardId);
      if (!card) throw new Error(`Unknown flashcard ${flashcardId}`);
      card.practice = { ...card.practice, ...changes, lastReviewedAt: new Date().toISOString() };
    },
  };
}
