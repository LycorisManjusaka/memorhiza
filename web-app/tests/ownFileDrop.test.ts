import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownFileSourceFromDrop, dropUrlCandidates } from '@/lib/ownFileDrop';

const O = 'http://localhost:3000';

test('a desk video dragged from a bubble is refetched by its URL, named by its path', () => {
  const src = ownFileSourceFromDrop(`${O}/api/workspace-file?folder=Cairn&path=original_creative_work%2F%E6%AE%8B%E3%81%A3%E3%81%9F%E7%9F%B3.mp4`, O);
  assert.ok(src);
  assert.equal(src!.name, '残った石.mp4');
  assert.ok(src!.url.startsWith('/api/workspace-file?'));
});

test('an attachment URL is refetched; no name is invented', () => {
  const src = ownFileSourceFromDrop(`${O}/api/attachments/abc.mp4`, O);
  assert.deepEqual(src, { url: '/api/attachments/abc.mp4', name: null });
});

test('other origins and unrelated routes are left to the dropped file', () => {
  assert.equal(ownFileSourceFromDrop('https://example.com/api/attachments/x.mp4', O), null);
  assert.equal(ownFileSourceFromDrop(`${O}/c/Default`, O), null);
  assert.equal(ownFileSourceFromDrop('', O), null);
  assert.equal(ownFileSourceFromDrop(null, O), null);
});

test('the URL is found in uri-list, html src, or DownloadURL', () => {
  const data: Record<string, string> = {
    'text/uri-list': '# c\r\nhttp://a/1',
    'text/html': '<video src="/api/workspace-file?folder=A&amp;path=v.mp4">',
    'DownloadURL': 'video/mp4:v.mp4:http://a/3',
  };
  assert.deepEqual(dropUrlCandidates(t => data[t] || ''), [
    'http://a/1', '/api/workspace-file?folder=A&path=v.mp4', 'http://a/3',
  ]);
});
