import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStoredWidth, sidebarDragResult, clampCameraWidth,
  SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_COLLAPSE_SLACK, CAMERA_MIN, CAMERA_MAX,
} from '@/lib/panelWidth';

test('nothing stored means the default layout (null), not some width', () => {
  // The promise to つよ: if nobody drags, nothing changes.
  assert.equal(parseStoredWidth(null, SIDEBAR_MIN, SIDEBAR_MAX), null);
  assert.equal(parseStoredWidth('', SIDEBAR_MIN, SIDEBAR_MAX), null);
  assert.equal(parseStoredWidth('wide', SIDEBAR_MIN, SIDEBAR_MAX), null);
});

test('a stored width is clamped into range', () => {
  assert.equal(parseStoredWidth('240', SIDEBAR_MIN, SIDEBAR_MAX), 240);
  assert.equal(parseStoredWidth('9999', SIDEBAR_MIN, SIDEBAR_MAX), SIDEBAR_MAX);
  assert.equal(parseStoredWidth('10', SIDEBAR_MIN, SIDEBAR_MAX), SIDEBAR_MIN);
});

test('sidebar never grows past its original width', () => {
  assert.deepEqual(sidebarDragResult(500), { width: SIDEBAR_MAX, collapse: false });
});

test('landing on the minimum pins it; dragging clearly past collapses', () => {
  assert.deepEqual(sidebarDragResult(SIDEBAR_MIN), { width: SIDEBAR_MIN, collapse: false });
  assert.equal(sidebarDragResult(SIDEBAR_MIN - SIDEBAR_COLLAPSE_SLACK + 1).collapse, false);
  assert.equal(sidebarDragResult(SIDEBAR_MIN - SIDEBAR_COLLAPSE_SLACK - 1).collapse, true);
});

test('camera clamps both ways and never collapses', () => {
  assert.equal(clampCameraWidth(0), CAMERA_MIN);
  assert.equal(clampCameraWidth(5000), CAMERA_MAX);
  assert.equal(clampCameraWidth(400), 400);
});
