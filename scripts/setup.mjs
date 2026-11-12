import { dataDir } from '../lib/config.mjs';
import { installTranscription } from '../lib/setup.mjs';

process.umask(0o077);
console.log('Setting up local transcription. This can take a few minutes.');
try {
  await installTranscription();
  console.log('Transcription is ready. Practice data: ' + dataDir);
} catch (error) {
  console.error(error.stderr?.trim().split('\n').at(-1) || error.message);
  process.exitCode = 1;
}
