// Scope the build heap separately from the 256 MB live-server runtime heap.
// No Next.js server runs in production: only its exported HTML/CSS/JS is served.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'build', 'web'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=384', NEXT_TELEMETRY_DISABLED: '1' },
});
child.on('exit', code => process.exit(code ?? 1));
