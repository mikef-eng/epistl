import { isValidUsernameFormat, USERNAME_FORMAT_ERROR } from '../username';

describe('isValidUsernameFormat', () => {
  it('accepts a plain alphanumeric username', () => {
    expect(isValidUsernameFormat('alice123')).toBe(true);
  });

  it('accepts underscores and dots', () => {
    expect(isValidUsernameFormat('alice_jones.dev')).toBe(true);
  });

  it('accepts the minimum length (3 chars)', () => {
    expect(isValidUsernameFormat('abc')).toBe(true);
  });

  it('accepts the maximum length (30 chars)', () => {
    expect(isValidUsernameFormat('a'.repeat(30))).toBe(true);
  });

  it('rejects fewer than 3 characters', () => {
    expect(isValidUsernameFormat('ab')).toBe(false);
  });

  it('rejects more than 30 characters', () => {
    expect(isValidUsernameFormat('a'.repeat(31))).toBe(false);
  });

  it('rejects a value containing a space', () => {
    expect(isValidUsernameFormat('bad name')).toBe(false);
  });

  it('rejects a value containing other punctuation (e.g. @)', () => {
    expect(isValidUsernameFormat('bad@name')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isValidUsernameFormat('')).toBe(false);
  });
});

describe('USERNAME_FORMAT_ERROR', () => {
  it('is a non-empty, human-readable message', () => {
    expect(USERNAME_FORMAT_ERROR.length).toBeGreaterThan(0);
  });
});
