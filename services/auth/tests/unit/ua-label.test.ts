import { describe, it, expect } from 'vitest';
import { buildVietnameseDeviceLabel } from '../../src/security/ua-label.js';

describe('Vietnamese User-Agent device label parsing', () => {
  it('formats Chrome on Windows correctly', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    expect(buildVietnameseDeviceLabel(ua)).toBe('Chrome trên Windows');
  });

  it('formats Safari on iPhone correctly', () => {
    const ua =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1';
    expect(buildVietnameseDeviceLabel(ua)).toBe('Mobile Safari trên iPhone');
  });

  it('formats Firefox on macOS correctly', () => {
    const ua =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0';
    expect(buildVietnameseDeviceLabel(ua)).toBe('Firefox trên Macintosh');
  });

  it('formats Edge on Windows correctly', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';
    expect(buildVietnameseDeviceLabel(ua)).toBe('Edge trên Windows');
  });

  it('handles null, empty or unknown UA string gracefully', () => {
    expect(buildVietnameseDeviceLabel(null)).toBe('Thiết bị không xác định');
    expect(buildVietnameseDeviceLabel('')).toBe('Thiết bị không xác định');
    expect(buildVietnameseDeviceLabel('CustomBot/1.0')).toBe('Thiết bị không xác định');
  });

  it('caps output to 80 characters maximum', () => {
    const veryLongUa = 'A'.repeat(500);
    const label = buildVietnameseDeviceLabel(veryLongUa);
    expect(label.length).toBeLessThanOrEqual(80);
  });
});
