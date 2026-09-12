import { base64ToUtf8, utf8ToBase64 } from '../src/utils/base64';

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
