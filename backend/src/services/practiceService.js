// Practice Mode service — deterministic practice state for a saved kit.
// Responsibilities: practice-state normalization, validation, ordering, progress, updates.
// Storage: state is persisted inside each flashcard as `practice: { confidence, covered, lastReviewedAt }`.

const {
  isPlainObject,
  trimString,
  toPlainKit,
} = require('./kitBuilderService');
const { hasUnsafeKeys, isSafeIdentifier } = require('./inputValidationService');

const MIN_CONFIDENCE = 1;
const MAX_CONFIDENCE = 5;
const CONFIDENCE_RANGE = Object.freeze({ min: MIN_CONFIDENCE, max: MAX_CONFIDENCE });
const DEFAULT_PRACTICE = Object.freeze({
  confidence: null,
  covered: false,
  lastReviewedAt: null,
});

class PracticeError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'PracticeError';
    this.code = code;
    this.status = Number.isInteger(options.status) ? options.status : 400;
    if (options.details !== undefined) this.details = options.details;
  }
}

const isValidConfidence = (value) =>
  value === null || (Number.isInteger(value) && value >= MIN_CONFIDENCE && value <= MAX_CONFIDENCE);

const normalizePracticeState = (value) => {
  const source = isPlainObject(value) ? value : {};
  const confidence = isValidConfidence(source.confidence) ? source.confidence : null;
  const covered = source.covered === true;
  const lastReviewedAt =
    typeof source.lastReviewedAt === 'string' && source.lastReviewedAt.trim()
      ? source.lastReviewedAt.trim()
      : null;
  return { confidence, covered, lastReviewedAt };
};

const applyFlashcardPracticeDefaults = (card) => {
  if (!isPlainObject(card)) return card;
  return { ...card, practice: normalizePracticeState(card.practice) };
};

const applyKitPracticeDefaults = (kit) => {
  const plain = toPlainKit(kit);
  if (!isPlainObject(plain) || !Array.isArray(plain.flashcards)) return plain;
  return { ...plain, flashcards: plain.flashcards.map(applyFlashcardPracticeDefaults) };
};

const withPracticeDefaults = (kit) => applyKitPracticeDefaults(kit);

const mergeStoredFlashcardPractice = (storedKit, kit) => {
  const plainKit = toPlainKit(kit);
  if (!isPlainObject(plainKit) || !Array.isArray(plainKit.flashcards)) return plainKit;
  const stored = toPlainKit(storedKit);
  const storedById = new Map();
  if (isPlainObject(stored) && Array.isArray(stored.flashcards)) {
    for (const card of stored.flashcards) {
      const id = trimString(card?.id);
      if (isPlainObject(card) && typeof id === 'string' && id) {
        storedById.set(id, card);
      }
    }
  }

  return {
    ...plainKit,
    flashcards: plainKit.flashcards.map((card) => {
      const id = trimString(card?.id);
      const previous = typeof id === 'string' ? storedById.get(id) : undefined;
      return {
        ...card,
        practice: previous ? normalizePracticeState(previous.practice) : { ...DEFAULT_PRACTICE },
      };
    }),
  };
};

const requirePracticeableKit = (kit) => {
  if (!isPlainObject(kit)) {
    throw new PracticeError('PRACTICE_INVALID_KIT', 'The kit could not be read for practice.', {
      status: 409,
    });
  }
  if (!Array.isArray(kit.flashcards)) {
    throw new PracticeError('PRACTICE_INVALID_KIT', 'The kit has no flashcards section to practice.', {
      status: 409,
      details: { flashcards: kit.flashcards === undefined ? 'missing' : typeof kit.flashcards },
    });
  }
  return kit.flashcards;
};

const practiceFlashcardView = (card) => {
  const id = trimString(card.id);
  const front = typeof card.front === 'string' ? card.front : (typeof card.term === 'string' ? card.term : '');
  const back = typeof card.back === 'string' ? card.back : (typeof card.definition === 'string' ? card.definition : '');
  const view = { id, front, back };

  if (Array.isArray(card.questionIds)) {
    view.questionIds = [...card.questionIds];
  } else if (Array.isArray(card.question_ids)) {
    view.questionIds = [...card.question_ids];
  }

  if (Array.isArray(card.requirement_ids)) {
    view.requirement_ids = [...card.requirement_ids];
  } else if (Array.isArray(card.requirementIds)) {
    view.requirement_ids = [...card.requirementIds];
  }

  return view;
};

// Next-session ordering rule:
// 1. Uncovered items first (covered: false before covered: true).
// 2. Unrated items (confidence === null) treated as needing practice, placed first.
// 3. Lower confidence first among rated items (1 through 5).
// 4. Stable tie-break by original flashcard array index in the kit.
const practiceSortKey = (item) => [
  item.practice.covered ? 1 : 0,
  item.practice.confidence === null ? 0 : 1,
  item.practice.confidence === null ? 0 : item.practice.confidence,
  item.index,
];

const comparePracticeItems = (a, b) => {
  const keyA = practiceSortKey(a);
  const keyB = practiceSortKey(b);
  for (let i = 0; i < keyA.length; i++) {
    if (keyA[i] !== keyB[i]) {
      return keyA[i] < keyB[i] ? -1 : 1;
    }
  }
  return 0;
};

const buildPracticeItems = (kit) => {
  const plain = toPlainKit(kit);
  const cards = requirePracticeableKit(plain);

  const indexedItems = [];
  cards.forEach((card, index) => {
    if (!isPlainObject(card)) return;
    const id = trimString(card.id);
    if (typeof id !== 'string' || !id) return;
    indexedItems.push({
      flashcard: practiceFlashcardView(card),
      practice: normalizePracticeState(card.practice),
      index,
    });
  });

  indexedItems.sort(comparePracticeItems);
  return indexedItems.map(({ flashcard, practice }) => ({ flashcard, practice }));
};

const roundTwoDecimals = (num) => Math.round(num * 100) / 100;

const computeProgress = (items) => {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  let covered = 0;
  let rated = 0;
  let sumConfidence = 0;

  for (const item of list) {
    if (item?.practice?.covered === true) {
      covered += 1;
    }
    const conf = item?.practice?.confidence;
    if (Number.isInteger(conf) && conf >= MIN_CONFIDENCE && conf <= MAX_CONFIDENCE) {
      rated += 1;
      sumConfidence += conf;
    }
  }

  const uncovered = total - covered;
  const unrated = total - rated;
  const averageConfidence = rated > 0 ? roundTwoDecimals(sumConfidence / rated) : null;

  return {
    total,
    covered,
    uncovered,
    rated,
    unrated,
    averageConfidence,
  };
};

const describeReceived = (value) => {
  if (value === null) return null;
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value;
};

const parsePracticeUpdate = (changes) => {
  if (!isPlainObject(changes) || hasUnsafeKeys(changes)) {
    throw new PracticeError('PRACTICE_INVALID_PAYLOAD', 'Practice update body must be a safe JSON object.', {
      status: 400,
      details: { received: describeReceived(changes) },
    });
  }

  const update = {};

  if (changes.confidence !== undefined) {
    if (!isValidConfidence(changes.confidence)) {
      throw new PracticeError(
        'PRACTICE_INVALID_CONFIDENCE',
        `confidence must be null or an integer between ${MIN_CONFIDENCE} and ${MAX_CONFIDENCE}.`,
        {
          status: 400,
          details: { received: describeReceived(changes.confidence) },
        }
      );
    }
    update.confidence = changes.confidence;
  }

  if (changes.covered !== undefined) {
    if (typeof changes.covered !== 'boolean') {
      throw new PracticeError('PRACTICE_INVALID_COVERED', 'covered must be a boolean.', {
        status: 400,
        details: { received: describeReceived(changes.covered) },
      });
    }
    update.covered = changes.covered;
  }

  if (Object.keys(update).length === 0) {
    throw new PracticeError(
      'PRACTICE_NO_UPDATABLE_FIELDS',
      'At least one of confidence or covered must be provided.',
      {
        status: 400,
        details: { acceptedFields: ['confidence', 'covered'] },
      }
    );
  }

  return update;
};

const requireFlashcardIndex = (cards, flashcardId) => {
  const target = isSafeIdentifier(flashcardId) ? flashcardId : null;
  const index = target ? cards.findIndex((card) => isPlainObject(card) && card.id === target) : -1;

  if (index === -1) {
    throw new PracticeError('PRACTICE_FLASHCARD_NOT_FOUND', 'No flashcard with that id exists in this kit.', {
      status: 404,
      details: { flashcardId: target },
    });
  }
  return index;
};

const updatePracticeState = ({ kit, flashcardId, changes } = {}) => {
  const plain = toPlainKit(kit);
  const cards = requirePracticeableKit(plain);
  const index = requireFlashcardIndex(cards, flashcardId);
  const update = parsePracticeUpdate(changes);

  const previous = normalizePracticeState(cards[index].practice);
  const nextPractice = {
    ...previous,
    ...update,
    lastReviewedAt: new Date().toISOString(),
  };

  const nextCards = cards.map((card, i) =>
    i === index ? { ...card, practice: nextPractice } : applyFlashcardPracticeDefaults(card)
  );

  const nextKit = { ...plain, flashcards: nextCards };
  const items = buildPracticeItems(nextKit);
  const targetId = trimString(cards[index].id);
  const updatedItem = items.find((item) => item.flashcard.id === targetId) ?? {
    flashcard: practiceFlashcardView(nextCards[index]),
    practice: nextPractice,
  };

  return {
    kit: nextKit,
    item: updatedItem,
    progress: computeProgress(items),
  };
};

module.exports = {
  MIN_CONFIDENCE,
  MAX_CONFIDENCE,
  CONFIDENCE_RANGE,
  DEFAULT_PRACTICE,
  PracticeError,
  isValidConfidence,
  normalizePracticeState,
  applyFlashcardPracticeDefaults,
  applyKitPracticeDefaults,
  withPracticeDefaults,
  mergeStoredFlashcardPractice,
  requirePracticeableKit,
  practiceFlashcardView,
  practiceSortKey,
  comparePracticeItems,
  buildPracticeItems,
  computeProgress,
  parsePracticeUpdate,
  requireFlashcardIndex,
  updatePracticeState,
};
