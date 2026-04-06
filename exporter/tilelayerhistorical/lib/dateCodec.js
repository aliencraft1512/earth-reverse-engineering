const MIN_YEAR = 1930;
const MAX_YEAR = 2100;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isValidDateParts(year, month, day) {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= MIN_YEAR &&
    year <= MAX_YEAR &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31
  );
}

function formatDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function encodeFToken(year, month, day) {
  if (!isValidDateParts(year, month, day)) {
    throw new Error(`Cannot encode invalid date ${year}-${month}-${day}`);
  }

  const code = ((year - 1920) << 9) | (month << 5) | day;
  return `f${code.toString(16)}`;
}

function decodeFToken(fToken) {
  const hex = String(fToken || '').replace(/^f/i, '');
  const code = Number.parseInt(hex, 16);

  if (!Number.isFinite(code)) {
    return null;
  }

  const year = (code >> 9) + 1920;
  const month = (code >> 5) & 0x0f;
  const day = code & 0x1f;

  if (!isValidDateParts(year, month, day)) {
    return null;
  }

  return {
    year,
    month,
    day,
    date: formatDate(year, month, day),
  };
}

function decodePackedDate(value) {
  const rawYear = value >> 9;
  const month = (value >> 5) & 0x0f;
  const day = value & 0x1f;

  const candidates = rawYear >= 1900 ? [rawYear] : [rawYear + 1920, rawYear];

  for (const year of candidates) {
    if (isValidDateParts(year, month, day)) {
      return formatDate(year, month, day);
    }
  }

  return null;
}

function makeEntryId(entry) {
  return `${entry.date}|${entry.iCode}|${entry.fToken}`;
}

function reconcileSelection(selectedEntryId, entries, options = {}) {
  if (!selectedEntryId) {
    return null;
  }

  if (entries.some(entry => makeEntryId(entry) === selectedEntryId)) {
    return selectedEntryId;
  }

  if (options.preferExactVersion !== false) {
    return null;
  }

  const [date, , fToken] = selectedEntryId.split('|');
  const compatibleEntries = entries
    .filter(entry => entry.date === date && entry.fToken === fToken)
    .sort((left, right) => {
      const leftPathCount = Number.isFinite(left.pathCount) ? left.pathCount : 0;
      const rightPathCount = Number.isFinite(right.pathCount) ? right.pathCount : 0;

      if (leftPathCount !== rightPathCount) {
        return rightPathCount - leftPathCount;
      }

      return right.iCode - left.iCode;
    });

  return compatibleEntries.length ? makeEntryId(compatibleEntries[0]) : null;
}

module.exports = {
  MIN_YEAR,
  MAX_YEAR,
  decodeFToken,
  decodePackedDate,
  encodeFToken,
  formatDate,
  isValidDateParts,
  makeEntryId,
  reconcileSelection,
};
