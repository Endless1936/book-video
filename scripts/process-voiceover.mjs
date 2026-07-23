#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { validateVoiceoverArtifact } from './lib/media-validation.mjs';
import { WorkflowError, installWorkflowDiagnostics } from './lib/workflow-diagnostics.mjs';

const ROOT = process.cwd();
installWorkflowDiagnostics({
  root: ROOT,
  command: 'node scripts/process-voiceover.mjs',
  stage: 'voiceover_processing',
  nextActions: [
    'Inspect the input audio path and the ffmpeg failure details.',
    'Repair or replace the source audio, then rerun the same preset.',
    'Do not replace the previous processed voiceover until the new output validates.',
  ],
});

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
  throw new WorkflowError('Usage: node scripts/process-voiceover.mjs <input.mp3> <output.mp3> [story]', {
    code: 'invalid_arguments',
  });
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const candidateOutput = `${output}.${process.pid}.tmp.mp3`;
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
  candidateOutput,
];

try {
  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new WorkflowError(`ffmpeg failed with status ${result.status ?? 'unknown'}`, {
      code: 'subprocess_failed',
      details: { command: 'ffmpeg', status: result.status, signal: result.signal },
    });
  }
  validateVoiceoverArtifact(candidateOutput);
  renameSync(candidateOutput, output);
} finally {
  rmSync(candidateOutput, { force: true });
}

console.log(`Processed voiceover with "${presetArg}" preset: ${output}`);
