import { describe, expect, it } from 'vitest';
import { detectIOS, detectWindows, isLikelyBluetoothLabel } from './platform';

describe('detectIOS', () => {
  it('detects iPhone Safari', () => {
    expect(
      detectIOS({
        userAgent:
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it('detects the iPadOS 13+ desktop-class UA (Mac platform string, touch capable)', () => {
    expect(
      detectIOS({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it('does not mistake a real (non-touch) Mac for iPadOS', () => {
    expect(
      detectIOS({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });

  it('requires more than one touch point on a Mac-platform UA', () => {
    expect(
      detectIOS({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 1,
      }),
    ).toBe(false);
  });

  it('does not match Chrome on Windows', () => {
    expect(
      detectIOS({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        platform: 'Win32',
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });

  it('does not match Edge on Windows', () => {
    expect(
      detectIOS({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
        platform: 'Win32',
        maxTouchPoints: 0,
      }),
    ).toBe(false);
  });

  it('does not match Chrome on Android', () => {
    expect(
      detectIOS({
        userAgent:
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      }),
    ).toBe(false);
  });
});

describe('detectWindows', () => {
  it('matches a Windows UA', () => {
    expect(detectWindows({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...' })).toBe(true);
  });

  it('does not match macOS or iOS UAs', () => {
    expect(detectWindows({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...' })).toBe(false);
    expect(detectWindows({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) ...' })).toBe(false);
  });
});

describe('isLikelyBluetoothLabel', () => {
  it.each([
    'AirPods Pro',
    'Bose QuietComfort 45',
    'JBL Flip 6',
    "Jabra Elite 75t",
    'Bluetooth Hands-Free Device',
    'Beats Studio3',
    'Sony WH-1000XM5',
    'Galaxy Buds2 Pro',
  ])('flags %s as likely Bluetooth', (label) => {
    expect(isLikelyBluetoothLabel(label)).toBe(true);
  });

  it.each(['iPhone Microphone', 'MacBook Pro Microphone', 'USB Audio Device', 'Yeti Stereo Microphone', 'Built-in Microphone'])(
    'does not flag %s',
    (label) => {
      expect(isLikelyBluetoothLabel(label)).toBe(false);
    },
  );

  it('is case-insensitive', () => {
    expect(isLikelyBluetoothLabel('AIRPODS PRO')).toBe(true);
  });
});
