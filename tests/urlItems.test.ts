import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterItemsForUrl } from '../src/shared/urlItems.ts'

const mk = (id: string, url?: string) => ({ id, url }) as any

test('keeps only items whose url is exactly the given url', () => {
  const items = [mk('a', 'https://x.com/p?q=1#h'), mk('b', 'https://x.com/p'), mk('c', 'https://x.com/p?q=1#h2'), mk('d')]
  assert.deepEqual(filterItemsForUrl(items, 'https://x.com/p?q=1#h').map(i => i.id), ['a'])
})

test('empty or missing url matches nothing (dictionary items without url)', () => {
  const items = [mk('a'), mk('b', '')]
  assert.deepEqual(filterItemsForUrl(items, ''), [])
  assert.deepEqual(filterItemsForUrl(items, undefined), [])
})
