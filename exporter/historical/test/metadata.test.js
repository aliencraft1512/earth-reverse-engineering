const test = require('node:test');
const assert = require('node:assert/strict');

const { extractMetadataEntriesWithDebug, fetchBuffer } = require('../metadata');

function encodeVarint(value) {
  const bytes = [];
  let current = value >>> 0;

  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }

  bytes.push(current);
  return Buffer.from(bytes);
}

function encodeField(fieldNumber, wireType, payload) {
  const key = encodeVarint((fieldNumber << 3) | wireType);

  if (wireType === 0) {
    return Buffer.concat([key, encodeVarint(payload)]);
  }

  if (wireType === 2) {
    return Buffer.concat([key, encodeVarint(payload.length), payload]);
  }

  throw new Error(`Unsupported wire type ${wireType}`);
}

test('extractMetadataEntriesWithDebug prefers the structured recursive parser', () => {
  const packedDate1 = ((2022 - 1920) << 9) | (6 << 5) | 11;
  const packedDate2 = ((2024 - 1920) << 9) | (4 << 5) | 6;
  const entry1 = Buffer.concat([
    encodeField(1, 0, packedDate1),
    encodeField(2, 0, 346),
    encodeField(3, 0, 4),
  ]);
  const entry2 = Buffer.concat([
    encodeField(1, 0, packedDate2),
    encodeField(2, 0, 350),
    encodeField(3, 0, 4),
  ]);
  const packet = Buffer.concat([
    encodeField(4, 2, entry1),
    encodeField(4, 2, entry2),
  ]);

  const extracted = extractMetadataEntriesWithDebug(packet);

  assert.equal(extracted.parser.mode, 'structured');
  assert.equal(extracted.entries.length, 2);
  assert.deepEqual(
    extracted.entries.map(entry => ({ date: entry.date, iCode: entry.iCode, fToken: entry.fToken })),
    [
      { date: '2024-04-06', iCode: 350, fToken: 'fd086' },
      { date: '2022-06-11', iCode: 346, fToken: 'fcccb' },
    ]
  );
});

test('fetchBuffer retries transient network resets and succeeds', async () => {
  const originalFetch = global.fetch;
  let attemptCount = 0;

  global.fetch = async () => {
    attemptCount += 1;

    if (attemptCount < 3) {
      const error = new Error('fetch failed');
      error.cause = { code: 'ECONNRESET' };
      throw error;
    }

    return {
      status: 200,
      headers: new Map(),
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    };
  };

  try {
    const response = await fetchBuffer('https://example.com/test', {
      retryCount: 3,
      retryDelayMs: 1,
    });

    assert.equal(attemptCount, 3);
    assert.deepEqual([...response.buffer], [1, 2, 3]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchBuffer includes the transport error code when retries are exhausted', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    const error = new Error('fetch failed');
    error.cause = { code: 'ECONNRESET' };
    throw error;
  };

  try {
    await assert.rejects(
      () => fetchBuffer('https://example.com/test', {
        retryCount: 2,
        retryDelayMs: 1,
      }),
      /ECONNRESET/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
