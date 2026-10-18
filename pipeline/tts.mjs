// Shared text-to-speech: provider selection plus a content-addressed cache.
// Used by narrate.mjs (in-video cues) and cards.mjs (intro/outro voiceover).
//
// Anthropic has no TTS API, so this calls a third party. Provider comes from
// DEMO_TTS, else whichever key is set:
//   ELEVENLABS_API_KEY -> elevenlabs   OPENAI_API_KEY -> openai
// Keys resolve via the shell or .env — never a committed file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Shared by every take and output folder, so a line is never billed twice.
const CACHE = path.join(HERE, '..', 'out', 'tts');
export const TTS_CACHE = CACHE;

export function pickProvider() {
  const forced = process.env.DEMO_TTS;
  const voiceOverride = process.env.DEMO_TTS_VOICE || null;

  const name =
    forced ??
    (process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : process.env.OPENAI_API_KEY ? 'openai' : null);

  if (!name) {
    throw new Error(
      'no text-to-speech key found. Set ELEVENLABS_API_KEY or OPENAI_API_KEY ' +
        '(shell or .env).',
    );
  }

  if (name === 'elevenlabs') {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('DEMO_TTS=elevenlabs but ELEVENLABS_API_KEY is not set');
    const voice = voiceOverride || '21m00Tcm4TlvDq8ikWAM';
    return {
      name,
      voice,
      async render(text) {
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`,
          {
            method: 'POST',
            headers: { 'xi-api-key': key, 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              model_id: 'eleven_multilingual_v2',
              voice_settings: { stability: 0.5, similarity_boost: 0.75 },
            }),
          },
        );
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          throw new Error(
            `ElevenLabs ${res.status}: ${body}` +
              (res.status === 402
                ? '\n(402 means the key is valid but the plan disallows this voice — ' +
                  'free tier cannot use library voices via the API.)'
                : ''),
          );
        }
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }

  if (name === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('DEMO_TTS=openai but OPENAI_API_KEY is not set');
    const voice = voiceOverride || 'alloy';
    return {
      name,
      voice,
      async render(text) {
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text }),
        });
        if (!res.ok) {
          throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }

  throw new Error(`unknown DEMO_TTS "${name}" (use elevenlabs or openai)`);
}

// ---- clip onset ----
// Text-to-speech does not start on the word. It starts on a breath: 100-160ms
// at -50 to -85 dB before the voice arrives, on every line that does not open
// with a vowel or a plosive. Cued at its file start, the line therefore begins
// with something barely audible and only then speaks, which is heard as the
// narration fading up — and it survives any amount of loudness normalisation,
// because normalising a breath just gives you a louder breath.
//
// So the head is measured and removed, and the line is cued on its first word.
//
// This is done by measuring rather than with `silenceremove`, which decides on
// peaks: a -55 dB breath carries brief peaks above a -45 dB gate and is kept,
// which is exactly the case that matters here. Measuring RMS in 20ms windows
// sees it for what it is.
const ONSET_DB = Number(process.env.TTS_ONSET_DB ?? -34); // level that counts as "speaking"
const ONSET_KEEP_MS = 40; // left in front, so the first consonant is not clipped
const ONSET_MAX_MS = 400; // never trim more than this, whatever the measurement says

const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function headSilenceMs(file) {
  const res = spawnSync(
    FFMPEG,
    [
      '-hide_banner', '-nostats',
      '-t', '1.5',
      '-i', file,
      '-af',
      'aresample=8000,asetnsamples=160,astats=metadata=1:reset=1,' +
        'ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-',
    ],
    { encoding: 'utf8' },
  );

  if (res.status !== 0) return 0;

  const levels = [];
  for (const line of (res.stdout ?? '').split(/\r?\n/)) {
    const m = /RMS_level=(-?[\d.]+|-?inf)/.exec(line);
    if (m) levels.push(m[1].includes('inf') ? -91 : Number(m[1]));
  }

  const first = levels.findIndex((v) => v > ONSET_DB);
  if (first <= 0) return 0; // already starts on the word, or nothing loud enough

  const ms = first * 20 - ONSET_KEEP_MS;
  return Math.max(0, Math.min(ms, ONSET_MAX_MS));
}

// Derived from the cached render, never in place of it: the .mp3 stays exactly
// as the provider returned it, so changing ONSET_DB re-derives from disk and
// re-bills nothing.
function trimHead(file) {
  const trimmed = file.replace(/\.mp3$/, '.lead.mp3');

  if (fs.existsSync(trimmed) && fs.statSync(trimmed).mtimeMs >= fs.statSync(file).mtimeMs) {
    return trimmed;
  }

  const ms = headSilenceMs(file);
  if (ms <= 0) return file;

  const res = spawnSync(
    FFMPEG,
    ['-y', '-v', 'error', '-ss', (ms / 1000).toFixed(3), '-i', file, '-c:a', 'libmp3lame', '-q:a', '2', trimmed],
    { encoding: 'utf8' },
  );

  if (res.status !== 0 || !fs.existsSync(trimmed)) return file;
  return trimmed;
}

// Renders text to an mp3, cached by provider+voice+text so nothing is billed
// twice. Returns { file, cached, trimmedMs }.
export async function speak(provider, text) {
  fs.mkdirSync(CACHE, { recursive: true });

  const hash = crypto
    .createHash('sha256')
    .update(`${provider.name}|${provider.voice}|${text}`)
    .digest('hex')
    .slice(0, 16);

  const raw = path.join(CACHE, `${hash}.mp3`);
  const cached = fs.existsSync(raw);

  if (!cached) fs.writeFileSync(raw, await provider.render(text));

  const file = trimHead(raw);
  const trimmedMs =
    file === raw ? 0 : Math.round((audioDuration(raw) - audioDuration(file)) * 1000);

  return { file, cached, trimmedMs };
}

export function audioDuration(file) {
  try {
    return Number(
      execFileSync(
        process.env.FFPROBE || 'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
        .toString()
        .trim(),
    );
  } catch {
    return 0;
  }
}
