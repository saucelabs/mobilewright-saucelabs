import { test, expect } from '@playwright/test';
import { decodeXmlEntities, parseXmlAttributes, parseXmlTree } from './xml.js';

test('parses double- and single-quoted attribute values', () => {
  expect(parseXmlAttributes(' text=\'say "hi"\' resource-id="app:id/x" class = "android.widget.EditText" /'))
    .toEqual({ text: 'say "hi"', 'resource-id': 'app:id/x', class: 'android.widget.EditText' });
});

test('decodes named and numeric XML entities, and keeps unknown ones', () => {
  expect(decodeXmlEntities('Tom &amp; Jerry &lt;3 &quot;&apos;&gt;')).toBe('Tom & Jerry <3 "\'>');
  expect(decodeXmlEntities('&#233;t&#xE9; &#x1F600;')).toBe('été 😀');
  expect(decodeXmlEntities('&nbsp; &amp')).toBe('&nbsp; &amp');
});

test('an empty value stays empty', () => {
  expect(parseXmlAttributes('text="" hint=\'\'')).toEqual({ text: '', hint: '' });
});

test('an out-of-range character reference is kept instead of failing the whole parse', () => {
  expect(decodeXmlEntities('a&#99999999;b&#x110000;c')).toBe('a&#99999999;b&#x110000;c');
});

test('parseXmlTree nests elements and handles self-closing tags and the XML declaration', () => {
  const xml = '<?xml version=\'1.0\'?><hierarchy><node id=\'a\'><node id=\'b\' /></node><node id=\'c\'/></hierarchy>';
  type N = { id?: string; children: N[] };
  const [root] = parseXmlTree<N>(xml, (_tag, attrs) => ({ id: attrs['id'], children: [] }));
  expect(root.children.map((n) => [n.id, n.children.map((c) => c.id)])).toEqual([['a', ['b']], ['c', []]]);
});
