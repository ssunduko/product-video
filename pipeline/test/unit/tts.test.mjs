// Voice selection (tts.mjs): which provider and voice every stage speaks with,
// and the presenter-avatar switch that overrides them.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { avatarEnabled, pickProvider } from '../../tts.mjs';

const KEYS = [
  'DEMO_AVATAR',
  'DEMO_AVATAR_VOICE',
  'DEMO_TTS',
  'DEMO_TTS_VOICE',
  'ELEVENLABS_API_KEY',
  'OPENAI_API_KEY',
];

// Every test starts from a clean slate and leaves the process as it found it,
// so a developer's own .env or shell cannot change a result.
let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('avatarEnabled', () => {
  test('is off when DEMO_AVATAR is unset or empty', () => {
    assert.equal(avatarEnabled(), false);
    process.env.DEMO_AVATAR = '';
    assert.equal(avatarEnabled(), false);
  });

  test('reads on and off, in any case and with stray spaces', () => {
    for (const v of ['on', 'ON', ' On ']) {
      process.env.DEMO_AVATAR = v;
      assert.equal(avatarEnabled(), true, v);
    }
    for (const v of ['off', 'OFF', ' off ']) {
      process.env.DEMO_AVATAR = v;
      assert.equal(avatarEnabled(), false, v);
    }
  });

  test('refuses any other value rather than treating it as off', () => {
    for (const v of ['1', 'true', 'yes', '0', 'onn']) {
      process.env.DEMO_AVATAR = v;
      assert.throws(() => avatarEnabled(), /DEMO_AVATAR must be on or off/, v);
    }
  });
});

describe('pickProvider', () => {
  test('fails without any text-to-speech key', () => {
    assert.throws(() => pickProvider(), /no text-to-speech key found/);
  });

  test('picks elevenlabs from its key, with the default voice', () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    const p = pickProvider();
    assert.equal(p.name, 'elevenlabs');
    assert.equal(p.voice, '21m00Tcm4TlvDq8ikWAM');
  });

  test('picks openai when only its key is set', () => {
    process.env.OPENAI_API_KEY = 'k';
    const p = pickProvider();
    assert.equal(p.name, 'openai');
    assert.equal(p.voice, 'alloy');
  });

  test('uses DEMO_TTS_VOICE while the avatar is off', () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    process.env.DEMO_TTS_VOICE = 'premium';
    process.env.DEMO_AVATAR_VOICE = 'presenter';
    process.env.DEMO_AVATAR = 'off';
    assert.equal(pickProvider().voice, 'premium');
  });

  test('the avatar voice takes precedence over DEMO_TTS_VOICE while on', () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    process.env.DEMO_TTS_VOICE = 'premium';
    process.env.DEMO_AVATAR_VOICE = 'presenter';
    process.env.DEMO_AVATAR = 'on';
    const p = pickProvider();
    assert.equal(p.name, 'elevenlabs');
    assert.equal(p.voice, 'presenter');
  });

  test('the avatar forces elevenlabs over DEMO_TTS=openai', () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    process.env.OPENAI_API_KEY = 'k';
    process.env.DEMO_TTS = 'openai';
    process.env.DEMO_AVATAR_VOICE = 'presenter';
    process.env.DEMO_AVATAR = 'on';
    assert.equal(pickProvider().name, 'elevenlabs');
  });

  test('the avatar without its voice is an error, not a silent fallback', () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    process.env.DEMO_TTS_VOICE = 'premium';
    process.env.DEMO_AVATAR = 'on';
    assert.throws(() => pickProvider(), /DEMO_AVATAR_VOICE is not set/);
  });

  test('the avatar without an ElevenLabs key names the avatar as the reason', () => {
    process.env.OPENAI_API_KEY = 'k';
    process.env.DEMO_AVATAR_VOICE = 'presenter';
    process.env.DEMO_AVATAR = 'on';
    assert.throws(() => pickProvider(), /DEMO_AVATAR is on but ELEVENLABS_API_KEY is not set/);
  });

  test('rejects an unknown DEMO_TTS', () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    process.env.DEMO_TTS = 'polly';
    assert.throws(() => pickProvider(), /unknown DEMO_TTS "polly"/);
  });
});

describe('render', () => {
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('asks ElevenLabs for the chosen voice and returns the audio', async () => {
    process.env.ELEVENLABS_API_KEY = 'secret';
    process.env.DEMO_AVATAR = 'on';
    process.env.DEMO_AVATAR_VOICE = 'presenter';
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };

    const audio = await pickProvider().render('Hello.');

    assert.deepEqual([...audio], [1, 2, 3]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/text-to-speech\/presenter\?/);
    assert.equal(calls[0].init.headers['xi-api-key'], 'secret');
    assert.equal(JSON.parse(calls[0].init.body).text, 'Hello.');
  });

  test('explains a 402 as a plan limit, not a bad key', async () => {
    process.env.ELEVENLABS_API_KEY = 'k';
    globalThis.fetch = async () => new Response('{"detail":"paid_plan_required"}', { status: 402 });
    await assert.rejects(pickProvider().render('x'), /ElevenLabs 402[\s\S]*plan disallows this voice/);
  });
});
