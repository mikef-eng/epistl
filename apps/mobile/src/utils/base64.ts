/**
 * Minimal, dependency-free UTF-8 <-> base64 conversion.
 *
 * Neither `btoa`/`atob` nor `Buffer` are guaranteed to exist in the Hermes
 * runtime React Native ships with, so this implements the conversion in
 * plain JS rather than relying on either. Used by `ChatScreen` to encode
 * outgoing message text before it goes over the wire/into storage, and to
 * decode incoming/stored message bodies back into displayable text.
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let codePoint = text.charCodeAt(i);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return bytes;
}

function bytesToUtf8(bytes: number[]): string {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const byte0 = bytes[i];
    let codePoint: number;
    let extraBytes: number;

    if (byte0 < 0x80) {
      codePoint = byte0;
      extraBytes = 0;
    } else if ((byte0 & 0xe0) === 0xc0) {
      codePoint = byte0 & 0x1f;
      extraBytes = 1;
    } else if ((byte0 & 0xf0) === 0xe0) {
      codePoint = byte0 & 0x0f;
      extraBytes = 2;
    } else if ((byte0 & 0xf8) === 0xf0) {
      codePoint = byte0 & 0x07;
      extraBytes = 3;
    } else {
      // Not a valid UTF-8 lead byte; skip it rather than throw.
      i++;
      continue;
    }

    for (let j = 1; j <= extraBytes; j++) {
      const next = bytes[i + j];
      if (next === undefined) {
        codePoint = -1;
        break;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    i += extraBytes + 1;

    if (codePoint < 0) {
      continue;
    }

    if (codePoint > 0xffff) {
      const adjusted = codePoint - 0x10000;
      result += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    } else {
      result += String.fromCharCode(codePoint);
    }
  }
  return result;
}

/** Encodes `text` as UTF-8 bytes, then base64. */
export function utf8ToBase64(text: string): string {
  const bytes = utf8Bytes(text);
  let result = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    result += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    result += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }

  return result;
}

/** Encodes raw bytes as base64, with no UTF-8 interpretation. */
export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    result += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    result += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }

  return result;
}

/** Decodes a base64 string into raw bytes, with no UTF-8 interpretation. */
export function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;

  for (const char of cleaned) {
    const value = BASE64_CHARS.indexOf(char);
    if (value === -1) {
      continue;
    }
    buffer = (buffer << 6) | value;
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

/** Decodes a base64 string, interpreting the resulting bytes as UTF-8. */
export function base64ToUtf8(base64: string): string {
  const cleaned = base64.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;

  for (const char of cleaned) {
    const value = BASE64_CHARS.indexOf(char);
    if (value === -1) {
      continue;
    }
    buffer = (buffer << 6) | value;
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }

  return bytesToUtf8(bytes);
}
