// Translate standard preview CLI flags to Next's CLI without a second server.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let host = '127.0.0.1', port = process.env.PORT || '3000';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host' || args[i] === '--hostname') host = args[++i];
  else if (args[i] === '--port') port = args[++i];
  else if (args[i] !== '--strictPort') throw new Error(`Unsupported dev argument: ${args[i]}`);
}
if (!host || !/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('Invalid preview host or port.');
const child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', 'web', '--hostname', host, '--port', port], { stdio: 'inherit', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
