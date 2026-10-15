import { describe, expect, it } from 'vitest';
import { assertBase64, ForkForgeInputError } from './model.js';

describe('base64 file-content bounds', () => {
  it('accepts a valid value at the eight MiB encoded limit without recursive validation', () => {
    const value = 'YWJj'.repeat(2 * 1024 * 1024);
    expect(assertBase64(value, 'content')).toBe(value);
  });

  it('retains the encoded size limit', () => {
    expect(() => assertBase64('AAAA'.repeat(2 * 1024 * 1024 + 1), 'content')).toThrow('too large');
  });

  it.each(['', 'YQ==', 'YWI=', 'YWJj', 'AAEC'])('accepts valid base64 %j', value => {
    expect(assertBase64(value, 'content')).toBe(value);
  });

  it.each(['A', 'AAA', '====', 'A===', 'AA=A', 'YW h', 'YW-h', 'YW_h', 'YWFh\n', 'YQ==\n'])('rejects malformed base64 %j', value => {
    expect(() => assertBase64(value, 'content')).toThrow(ForkForgeInputError);
  });
});
