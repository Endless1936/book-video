#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const presets = {
  story: [
    'highpass=f=70',
    'lowpass=f=14500',
    'equalizer=f=180:g=-1.0',
    'equalizer=f=950:g=1.2',
    'equalizer=f=3100:g=2.0',
    'equalizer=f=7200:g=0.8',
    'acompressor=threshold=-24dB:ratio=3.0:attack=8:release=160:makeup=4',
    'alimiter=limit=0.92',
    'loudnorm=I=-14.0:TP=-1.0:LRA=4.0',
  ].join(','),
};

function usage() {
  console.error('Usage: node scripts/process-voiceover.mjs <input.mp3> <output.mp3> [story]');
  console.error(`Available presets: ${Object.keys(presets).join(', ')}`);
}

const [, , inputArg, outputArg, presetArg = 'story'] = process.argv;

if (!inputArg || !outputArg || !presets[presetArg]) {
  usage();
  process.exit(1);
}

const input = resolve(inputArg);
const output = resolve(outputArg);
mkdirSync(dirname(output), { recursive: true });

const args = [
  '-y',
  '-i',
  input,
  '-vn',
  '-af',
  presets[presetArg],
  '-codec:a',
  'libmp3lame',
  '-b:a',
  '192k',
  output,
];

const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Processed voiceover with "${presetArg}" preset: ${output}`);
