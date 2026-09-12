import { base64ToBytes, base64ToUtf8, bytesToBase64, utf8ToBase64 } from '../src/utils/base64';

describe('base64 utils', () => {
  it.each([
    ['hi', 'aGk='],
    ['hello', 'aGVsbG8='],
    ['hey there', 'aGV5IHRoZXJl'],
    ['', ''],
  ])('encodes %j to %j', (text, expected) => {
    expect(utf8ToBase64(text)).toBe(expected);
  });

  it.each([
    ['aGk=', 'hi'],
    ['aGVsbG8=', 'hello'],
    ['aGV5IHRoZXJl', 'hey there'],
    ['', ''],
  ])('decodes %j to %j', (b64, expected) => {
    expect(base64ToUtf8(b64)).toBe(expected);
  });

  it('round-trips non-ASCII text', () => {
    const text = 'héllo 👋 wörld';
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });
});

describe('raw byte base64 codec', () => {
  it('round-trips an empty array', () => {
    const bytes = new Uint8Array([]);
    expect(bytesToBase64(bytes)).toBe('');
    expect(base64ToBytes('')).toEqual(bytes);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 1184, 3309])(
    'round-trips a byte array of length %d not necessarily divisible by 3',
    (length) => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = (i * 37 + 11) % 256;
      }

      const encoded = bytesToBase64(bytes);
      const decoded = base64ToBytes(encoded);
      expect(decoded).toEqual(bytes);
    }
  );

  it('round-trips all byte values 0-255', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
