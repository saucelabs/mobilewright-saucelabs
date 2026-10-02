/**
 * Reads one top-level string value from a property list, binary (`bplist00`, what Xcode puts in an app's
 * Info.plist) or XML. Just enough to get an app's CFBundleIdentifier, without a plist dependency.
 */
export function plistString(data: Buffer, key: string): string | undefined {
  if (data.subarray(0, 8).toString('latin1') === 'bplist00') return binaryPlistString(data, key);
  const xml = data.toString('utf8');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`));
  return match?.[1];
}

/**
 * Binary plist: a trailer locates the offset table, which locates each object; the top object is the root dict.
 * Offsets and counts come from the file, so each is checked against its size: a malformed file reads as "not found".
 */
function binaryPlistString(data: Buffer, key: string): string | undefined {
  const trailer = data.length - 32;
  if (trailer < 8) return undefined;
  const offsetSize = data[trailer + 6];
  const refSize = data[trailer + 7];
  const objectCount = Number(data.readBigUInt64BE(trailer + 8));
  const topObject = Number(data.readBigUInt64BE(trailer + 16));
  const offsetTable = Number(data.readBigUInt64BE(trailer + 24));
  if (!offsetSize || !refSize || topObject >= objectCount || offsetTable + objectCount * offsetSize > trailer) return undefined;
  const offsetOf = (ref: number) => (ref < objectCount ? readUInt(data, offsetTable + ref * offsetSize, offsetSize) : -1);

  const root = offsetOf(topObject);
  if (!inside(data, root) || data[root] >> 4 !== 0xd) return undefined;
  const { count, start } = objectLength(data, root);
  if (start + 2 * count * refSize > trailer) return undefined;
  for (let i = 0; i < count; i++) {
    const keyRef = readUInt(data, start + i * refSize, refSize);
    if (readString(data, offsetOf(keyRef)) !== key) continue;
    const valueRef = readUInt(data, start + (count + i) * refSize, refSize);
    return readString(data, offsetOf(valueRef));
  }
  return undefined;
}

function inside(data: Buffer, offset: number): boolean {
  return Number.isInteger(offset) && offset >= 0 && offset < data.length;
}

/** An ASCII (0x5_) or UTF-16BE (0x6_) string object; undefined for any other type. */
function readString(data: Buffer, offset: number): string | undefined {
  if (!inside(data, offset)) return undefined;
  const type = data[offset] >> 4;
  if (type !== 0x5 && type !== 0x6) return undefined;
  const { count, start } = objectLength(data, offset);
  const end = start + count * (type === 0x5 ? 1 : 2);
  if (end > data.length) return undefined;
  if (type === 0x5) return data.toString('latin1', start, end);
  return Buffer.from(data.subarray(start, end)).swap16().toString('utf16le');
}

/** An object's element count (low nibble, or a following int object when it is 0xF) and where its content starts. */
function objectLength(data: Buffer, offset: number): { count: number; start: number } {
  const nibble = data[offset] & 0x0f;
  if (nibble !== 0x0f) return { count: nibble, start: offset + 1 };
  const intSize = 1 << (data[offset + 1] & 0x0f);
  return { count: readUInt(data, offset + 2, intSize), start: offset + 2 + intSize };
}

function readUInt(data: Buffer, offset: number, size: number): number {
  if (offset < 0 || offset + size > data.length) return Number.NaN;
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + data[offset + i];
  return value;
}
