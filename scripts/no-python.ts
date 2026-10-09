import { spawnSync } from 'node:child_process';
const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
  encoding: 'utf8',
  timeout: 10000,
});
if (probe.error || probe.status !== 0) {
  console.log(
    JSON.stringify({
      status: 'BLOCKED',
      reason:
        'Docker daemon is required for an actual clean environment without Python; no PATH-only substitute was used',
    }),
  );
  process.exitCode = 3;
} else {
  const build = spawnSync(
    'docker',
    [
      'build',
      '-f',
      'config/Dockerfile.no-python',
      '-t',
      'software-factory-no-python:local',
      '.',
    ],
    { stdio: 'inherit', timeout: 600000 },
  );
  if (build.status !== 0) process.exitCode = 2;
  else {
    const run = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'bridge',
        'software-factory-no-python:local',
      ],
      { stdio: 'inherit', timeout: 600000 },
    );
    process.exitCode = run.status ?? 2;
  }
}
