'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getProfile, selectProfileFromTags } = require('../src/profiles');

test('quality profiles retain the original QP and width settings', () => {
  assert.deepEqual(
    ['high', 'medium', 'low', 'lowres'].map((key) => {
      const profile = getProfile(key);
      return [profile.key, profile.qp, profile.maxWidth];
    }),
    [
      ['high', 22, 1920],
      ['medium', 24, 1920],
      ['low', 30, 1920],
      ['lowres', 26, 1280]
    ]
  );
});

test('profile tags support plain and prefixed names', () => {
  assert.equal(selectProfileFromTags(['transcode:high']).key, 'high');
  assert.equal(selectProfileFromTags(['LOWRES']).key, 'lowres');
  assert.equal(selectProfileFromTags(['unrelated'], 'low').key, 'low');
});

test('skip has priority over encoding profiles', () => {
  assert.equal(selectProfileFromTags(['high', 'skip']).key, 'skip');
});
