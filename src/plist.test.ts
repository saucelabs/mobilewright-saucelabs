import { test, expect } from '@playwright/test';
import { plistString } from './plist.js';

/**
 * `plutil -convert binary1` of a plist with CFBundleIdentifier "com.example.App", CFBundleDisplayName
 * "Café ☕" (stored as UTF-16), CFBundleVersion 42, an array and a boolean.
 */
const BINARY = Buffer.from(
  'YnBsaXN0MDDVAQIDBAUGBwgJCl8QD0NGQnVuZGxlVmVyc2lvbl8QE0NGQnVuZGxlRGlzcGxheU5hbWVfEBJMU1JlcXVpcmVzSVBob25lT1NfEBJDRkJ1bmRsZUlkZW50aWZpZXJfEBxVSVJlcXVpcmVkRGV2aWNlQ2FwYWJpbGl0aWVzECpmAEMAYQBmAOkAICYVCV8QD2NvbS5leGFtcGxlLkFwcKELVWFybTY0CBMlO1BlhIaTlKaoAAAAAAAAAQEAAAAAAAAADAAAAAAAAAAAAAAAAAAAAK4=',
  'base64',
);

test('reads string values from a binary plist, ASCII and UTF-16', () => {
  expect(plistString(BINARY, 'CFBundleIdentifier')).toBe('com.example.App');
  expect(plistString(BINARY, 'CFBundleDisplayName')).toBe('Café ☕');
});

test('returns undefined for a missing key or a value that is not a string', () => {
  expect(plistString(BINARY, 'NoSuchKey')).toBeUndefined();
  expect(plistString(BINARY, 'CFBundleVersion')).toBeUndefined();
  expect(plistString(BINARY, 'LSRequiresIPhoneOS')).toBeUndefined();
});

test('reads string values from an XML plist', () => {
  const xml = Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict>\n'
    + '<key>CFBundleName</key><string>App</string>\n<key>CFBundleIdentifier</key>\n  <string>com.example.Xml</string>\n</dict></plist>');
  expect(plistString(xml, 'CFBundleIdentifier')).toBe('com.example.Xml');
  expect(plistString(xml, 'Missing')).toBeUndefined();
});

test('a malformed binary plist reads as not found, without hanging or throwing', () => {
  // A huge element count in the root dict, and offsets pointing past the end.
  const broken = Buffer.from(BINARY);
  broken[broken.length - 32 + 24 + 7] = 0xff; // offset table beyond the file
  expect(plistString(broken, 'CFBundleIdentifier')).toBeUndefined();
  const truncated = BINARY.subarray(0, 20);
  expect(plistString(Buffer.concat([Buffer.from('bplist00'), truncated]), 'CFBundleIdentifier')).toBeUndefined();
  const hugeCount = Buffer.from(BINARY);
  const root = hugeCount.indexOf(0xd5); // the root dict marker (5 entries)
  hugeCount[root] = 0xdf; // count in a following int object…
  hugeCount[root + 1] = 0x13; // …8 bytes long
  expect(plistString(hugeCount, 'CFBundleIdentifier')).toBeUndefined();
});
