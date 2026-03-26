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

    if (!Number.isFinite(iCode) || iCode <= 0 || iCode >= 10000) {
      continue;
    }

    pushUniqueEntry(
      results,
      {
        date,
        iCode,
        fToken: encodeFToken(...date.split('-').map(Number)),
        rawDate,
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

      if (!Number.isFinite(iCode) || iCode <= 0 || iCode >= 10000) {
        continue;
      }

      pushUniqueEntry(
        results,
        {
          date,
          iCode,
          fToken: encodeFToken(...date.split('-').map(Number)),
          rawDate,
        },
        seen
      );
    } catch (error) {
      // Skip malformed candidate offsets.
    }
  }
}

function extractMetadataEntries(buffer) {
  const results = [];
  const seen = new Set();

  extractPatternEntries(buffer, results, seen);

  if (results.length === 0) {
    extractLooseEntries(buffer, results, seen);
  }

  return results.sort((left, right) => {
    const byDate = right.date.localeCompare(left.date);
    if (byDate !== 0) {
      return byDate;
    }

    return right.iCode - left.iCode;
  });
}

async function fetchBuffer(url, options = {}) {
  const {
    headers = DEFAULT_REQUEST_HEADERS,
    timeoutMs = 10000,
    validateStatus = status => status === 200,
  } = options;

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
  } finally {
    clearTimeout(timer);
  }
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
    };
  }

  const inflated = zlib.inflateSync(decrypted.subarray(8));

  return {
    url,
    decrypted,
    inflated,
    entries: extractMetadataEntries(inflated),
  };
}

module.exports = {
  DEFAULT_REQUEST_HEADERS,
  decryptXOR,
  extractMetadataEntries,
  fetchBuffer,
  fetchMetadataPacket,
  readSecretKey,
  readVarint,
};
