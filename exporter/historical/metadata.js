const fs = require('fs');
const zlib = require('zlib');

const { decodePackedDate, encodeFToken, makeEntryId } = require('./dateCodec');

const DEFAULT_REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

function readSecretKey(dbRootPath) {
  if (!fs.existsSync(dbRootPath)) {
    return null;
  }

  return fs.readFileSync(dbRootPath);
}

function decryptXOR(buffer, secretKey) {
  if (!secretKey) {
    return Buffer.from(buffer);
  }

  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const output = Buffer.alloc(source.length);
  let j = 16;

  for (let index = 0; index < source.length; index += 1) {
    const keyByte = secretKey[(j + 8) % secretKey.length];
    output[index] = source[index] ^ keyByte;
    j += 1;

    if (j % 8 === 0) {
      j += 16;
    }

    if (j >= 1016) {
      j = (j + 8) % 24;
    }
  }

  return output;
}

function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = BigInt(buffer[cursor]);
    cursor += 1;
    result |= (byte & 0x7fn) << shift;

    if ((byte & 0x80n) === 0n) {
      return { value: Number(result), next: cursor };
    }

    shift += 7n;
  }

  return { value: Number(result), next: cursor, error: 'EOF' };
}

function pushUniqueEntry(results, entry, seen) {
  const id = makeEntryId(entry);

  if (seen.has(id)) {
    return;
  }

  seen.add(id);
  results.push(entry);
}

function isValidVersion(value) {
  return Number.isFinite(value) && value > 0 && value < 10000;
}

function looksLikeNestedMessage(buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }

  try {
    const { value: key, next, error } = readVarint(buffer, 0);

    if (error || next > buffer.length) {
      return false;
    }

    const field = key >> 3;
    const wireType = key & 7;
    return field > 0 && field < 64 && [0, 1, 2, 5].includes(wireType);
  } catch (error) {
    return false;
  }
}

function parseProtobufMessage(buffer, options = {}) {
  const {
    depth = 0,
    maxDepth = 6,
    path = 'root',
    stats = null,
  } = options;
  const fields = [];
  const fieldCounts = new Map();
  let cursor = 0;

  if (stats) {
    stats.messageCount += 1;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
  }

  while (cursor < buffer.length) {
    const fieldStart = cursor;
    const { value: key, next: afterKey, error } = readVarint(buffer, cursor);

    if (error) {
      if (stats) {
        stats.truncatedFields += 1;
      }
      return { fields, error: 'EOF while reading field key', consumed: cursor, path };
    }

    cursor = afterKey;

    const field = key >> 3;
    const wireType = key & 7;
    const occurrence = fieldCounts.get(field) || 0;
    fieldCounts.set(field, occurrence + 1);
    const fieldPath = `${path}.${field}[${occurrence}]`;

    if (field <= 0) {
      if (stats) {
        stats.invalidFieldNumbers += 1;
      }
      return { fields, error: `Invalid field number ${field}`, consumed: cursor, path };
    }

    if (wireType === 0) {
      const { value, next, error: valueError } = readVarint(buffer, cursor);

      if (valueError) {
        if (stats) {
          stats.truncatedFields += 1;
        }
        return { fields, error: 'EOF while reading varint', consumed: cursor, path };
      }

      fields.push({
        field,
        wireType,
        value,
        path: fieldPath,
        offset: fieldStart,
      });
      cursor = next;
      continue;
    }

    if (wireType === 1) {
      if (cursor + 8 > buffer.length) {
        if (stats) {
          stats.truncatedFields += 1;
        }
        return { fields, error: 'EOF while reading 64-bit field', consumed: cursor, path };
      }

      fields.push({
        field,
        wireType,
        value: buffer.subarray(cursor, cursor + 8),
        path: fieldPath,
        offset: fieldStart,
      });
      cursor += 8;
      continue;
    }

    if (wireType === 2) {
      const { value: length, next: afterLength, error: lengthError } = readVarint(buffer, cursor);

      if (lengthError || afterLength + length > buffer.length) {
        if (stats) {
          stats.truncatedFields += 1;
        }
        return { fields, error: 'EOF while reading length-delimited field', consumed: cursor, path };
      }

      const value = buffer.subarray(afterLength, afterLength + length);
      let nested = null;

      if (depth < maxDepth && looksLikeNestedMessage(value)) {
        const parsedNested = parseProtobufMessage(value, {
          depth: depth + 1,
          maxDepth,
          path: fieldPath,
          stats,
        });

        if (!parsedNested.error) {
          nested = parsedNested;
        }
      }

      fields.push({
        field,
        wireType,
        length,
        value,
        nested,
        path: fieldPath,
        offset: fieldStart,
      });
      cursor = afterLength + length;
      continue;
    }

    if (wireType === 5) {
      if (cursor + 4 > buffer.length) {
        if (stats) {
          stats.truncatedFields += 1;
        }
        return { fields, error: 'EOF while reading 32-bit field', consumed: cursor, path };
      }

      fields.push({
        field,
        wireType,
        value: buffer.subarray(cursor, cursor + 4),
        path: fieldPath,
        offset: fieldStart,
      });
      cursor += 4;
      continue;
    }

    if (stats) {
      stats.unsupportedWireTypes += 1;
    }
    return { fields, error: `Unsupported wire type ${wireType}`, consumed: cursor, path };
  }

  return { fields, consumed: cursor, path };
}

function extractStructuredEntries(buffer, results, seen, parserStats) {
  const stats = {
    messageCount: 0,
    maxDepth: 0,
    unsupportedWireTypes: 0,
    truncatedFields: 0,
    invalidFieldNumbers: 0,
    candidateMessages: 0,
    acceptedMessages: 0,
  };
  const root = parseProtobufMessage(buffer, { stats });

  function visitMessage(message) {
    const scalarFields = message.fields.filter(field => field.wireType === 0);
    const nestedFields = message.fields.filter(field => field.nested);
    const candidateDates = [...new Set(
      scalarFields
        .filter(field => field.field === 1)
        .map(field => decodePackedDate(field.value))
        .filter(Boolean)
    )];
    const candidateVersions = [...new Set(
      scalarFields
        .filter(field => field.field === 2)
        .map(field => field.value)
        .filter(isValidVersion)
    )];

    if (candidateDates.length === 1 && candidateVersions.length > 0 && nestedFields.length === 0) {
      stats.candidateMessages += 1;

      for (const iCode of candidateVersions) {
        pushUniqueEntry(
          results,
          {
            date: candidateDates[0],
            iCode,
            fToken: encodeFToken(...candidateDates[0].split('-').map(Number)),
            parser: 'structured',
            messagePath: message.path,
          },
          seen
        );
      }

      stats.acceptedMessages += 1;
    }

    for (const nestedField of nestedFields) {
      visitMessage(nestedField.nested);
    }
  }

  if (!root.error) {
    visitMessage(root);
  }

  parserStats.structured = stats;
  return root;
}

function extractFramedSubmessageEntries(buffer, results, seen, parserStats) {
  const stats = {
    scannedOffsets: 0,
    parsedFrames: 0,
    candidateFrames: 0,
    acceptedFrames: 0,
  };

  for (let index = 0; index < buffer.length - 2; index += 1) {
    if (buffer[index] !== 0x0a) {
      continue;
    }

    stats.scannedOffsets += 1;

    const { value: length, next, error } = readVarint(buffer, index + 1);

    if (error || next + length > buffer.length || length <= 0) {
      continue;
    }

    const payload = buffer.subarray(next, next + length);

    if (!looksLikeNestedMessage(payload)) {
      continue;
    }

    const parsed = parseProtobufMessage(payload, {
      path: `scan@${index}`,
    });

    if (parsed.error) {
      continue;
    }

    stats.parsedFrames += 1;

    const scalarFields = parsed.fields.filter(field => field.wireType === 0);
    const candidateDates = [...new Set(
      scalarFields
        .filter(field => field.field === 1)
        .map(field => decodePackedDate(field.value))
        .filter(Boolean)
    )];
    const candidateVersions = [...new Set(
      scalarFields
        .filter(field => field.field === 2)
        .map(field => field.value)
        .filter(isValidVersion)
    )];

    if (candidateDates.length !== 1 || candidateVersions.length === 0) {
      continue;
    }

    stats.candidateFrames += 1;

    for (const iCode of candidateVersions) {
      pushUniqueEntry(
        results,
        {
          date: candidateDates[0],
          iCode,
          fToken: encodeFToken(...candidateDates[0].split('-').map(Number)),
          parser: 'framed',
          messagePath: parsed.path,
        },
        seen
      );
    }

    stats.acceptedFrames += 1;
  }

  parserStats.framed = stats;
}

function extractPatternEntries(buffer, results, seen) {
  for (let index = 0; index < buffer.length - 5; index += 1) {
    if (buffer[index] !== 0x0a || buffer[index + 2] !== 0x08) {
      continue;
    }

    const { value: rawDate, next: afterDate } = readVarint(buffer, index + 3);
    const date = decodePackedDate(rawDate);

    if (!date || buffer[afterDate] !== 0x10) {
      continue;
    }

    const { value: iCode } = readVarint(buffer, afterDate + 1);

    if (!isValidVersion(iCode)) {
      continue;
    }

    pushUniqueEntry(
      results,
      {
        date,
        iCode,
        fToken: encodeFToken(...date.split('-').map(Number)),
        rawDate,
        parser: 'pattern',
      },
      seen
    );
  }
}

function extractLooseEntries(buffer, results, seen) {
  for (let index = 0; index < buffer.length - 3; index += 1) {
    if (buffer[index] !== 0x08) {
      continue;
    }

    try {
      const { value: rawDate, next: afterDate } = readVarint(buffer, index + 1);
      const date = decodePackedDate(rawDate);

      if (!date || buffer[afterDate] !== 0x10) {
        continue;
      }

      const { value: iCode } = readVarint(buffer, afterDate + 1);

      if (!isValidVersion(iCode)) {
        continue;
      }

      pushUniqueEntry(
        results,
        {
          date,
          iCode,
          fToken: encodeFToken(...date.split('-').map(Number)),
          rawDate,
          parser: 'loose',
        },
        seen
      );
    } catch (error) {
      // Skip malformed candidate offsets.
    }
  }
}

function sortEntries(entries) {
  return entries.sort((left, right) => {
    const byDate = right.date.localeCompare(left.date);
    if (byDate !== 0) {
      return byDate;
    }

    return right.iCode - left.iCode;
  });
}

function extractMetadataEntriesWithDebug(buffer) {
  const results = [];
  const seen = new Set();
  const parserStats = {};

  extractStructuredEntries(buffer, results, seen, parserStats);

  if (results.length > 0) {
    return {
      entries: sortEntries(results),
      parser: {
        mode: 'structured',
        acceptedCount: results.length,
        ...parserStats,
      },
    };
  }

  extractFramedSubmessageEntries(buffer, results, seen, parserStats);

  if (results.length > 0) {
    return {
      entries: sortEntries(results),
      parser: {
        mode: 'framed',
        acceptedCount: results.length,
        ...parserStats,
      },
    };
  }

  extractPatternEntries(buffer, results, seen);

  if (results.length > 0) {
    return {
      entries: sortEntries(results),
      parser: {
        mode: 'pattern',
        acceptedCount: results.length,
        ...parserStats,
      },
    };
  }

  extractLooseEntries(buffer, results, seen);

  if (results.length === 0) {
    return {
      entries: [],
      parser: {
        mode: 'none',
        acceptedCount: 0,
        ...parserStats,
      },
    };
  }

  return {
    entries: sortEntries(results),
    parser: {
      mode: 'loose',
      acceptedCount: results.length,
      ...parserStats,
    },
  };
}

function extractMetadataEntries(buffer) {
  return extractMetadataEntriesWithDebug(buffer).entries;
}

function isRetryableFetchError(error) {
  if (!error) {
    return false;
  }

  const code = error.code || error.cause?.code || null;

  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }

  return error.name === 'AbortError';
}

function formatFetchErrorMessage(error) {
  const code = error?.code || error?.cause?.code || null;
  const message = error?.message || 'fetch failed';

  if (!code || message.includes(code)) {
    return message;
  }

  return `${message} (${code})`;
}

async function fetchBuffer(url, options = {}) {
  const {
    headers = DEFAULT_REQUEST_HEADERS,
    timeoutMs = 10000,
    retryCount = 3,
    retryDelayMs = 250,
    validateStatus = status => status === 200,
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      if (!validateStatus(response.status)) {
        const error = new Error(`Unexpected status ${response.status}`);
        error.status = response.status;
        throw error;
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        status: response.status,
        headers: response.headers,
        buffer: Buffer.from(arrayBuffer),
      };
    } catch (error) {
      lastError = error;

      if (!isRetryableFetchError(error) || attempt >= retryCount) {
        const wrappedError = new Error(formatFetchErrorMessage(error));
        wrappedError.status = error.status;
        wrappedError.code = error.code || error.cause?.code;
        wrappedError.cause = error;
        throw wrappedError;
      }

      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

async function fetchMetadataPacket({
  baseUrl,
  pathCode,
  rootVersion,
  requestHeaders = DEFAULT_REQUEST_HEADERS,
  timeoutMs = 10000,
  secretKey = null,
}) {
  const url = `${baseUrl}&qp-${pathCode}-q.${rootVersion}`;
  const response = await fetchBuffer(url, {
    headers: requestHeaders,
    timeoutMs,
    validateStatus: status => status === 200,
  });
  const decrypted = decryptXOR(response.buffer, secretKey);

  if (decrypted.length <= 8) {
    return {
      url,
      decrypted,
      inflated: Buffer.alloc(0),
      entries: [],
      parser: {
        mode: 'none',
        acceptedCount: 0,
      },
    };
  }

  const inflated = zlib.inflateSync(decrypted.subarray(8));
  const extracted = extractMetadataEntriesWithDebug(inflated);

  return {
    url,
    decrypted,
    inflated,
    entries: extracted.entries,
    parser: {
      ...extracted.parser,
      decryptedSize: decrypted.length,
      inflatedSize: inflated.length,
    },
  };
}

module.exports = {
  DEFAULT_REQUEST_HEADERS,
  decryptXOR,
  extractMetadataEntries,
  extractMetadataEntriesWithDebug,
  fetchBuffer,
  fetchMetadataPacket,
  parseProtobufMessage,
  readSecretKey,
  readVarint,
};
