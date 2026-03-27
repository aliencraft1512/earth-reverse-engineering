const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIRECTORY = path.resolve(__dirname, '..', '..', '..');
const REPORT_DIRECTORY = path.join(__dirname, '..', 'output');
const DEFAULT_SEED = 20260327;
const DEFAULT_LIMIT = 4;
const DEFAULT_CLICKS = 2;

function parseCliArgs(argv) {
  const options = {
    seed: DEFAULT_SEED,
    limit: DEFAULT_LIMIT,
    clicks: DEFAULT_CLICKS,
  };

  for (const argument of argv) {
    if (argument.startsWith('--seed=')) {
      options.seed = Number.parseInt(argument.slice('--seed='.length), 10);
      continue;
    }

    if (argument.startsWith('--limit=')) {
      options.limit = Number.parseInt(argument.slice('--limit='.length), 10);
      continue;
    }

    if (argument.startsWith('--clicks=')) {
      options.clicks = Number.parseInt(argument.slice('--clicks='.length), 10);
    }
  }

  if (!Number.isFinite(options.seed)) {
    options.seed = DEFAULT_SEED;
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) {
    options.limit = DEFAULT_LIMIT;
  }

  if (!Number.isFinite(options.clicks) || options.clicks < 1) {
    options.clicks = DEFAULT_CLICKS;
  }

  return options;
}

function runStep(label, command, args, options = {}) {
  console.log(`[historical-health] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT_DIRECTORY,
    stdio: 'inherit',
    shell: Boolean(options.shell),
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const reportPath = path.join(REPORT_DIRECTORY, 'historical-health-report.json');
  fs.mkdirSync(REPORT_DIRECTORY, { recursive: true });

  const unitStatus = runStep(
    'running regression tests',
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['test'],
    { shell: process.platform === 'win32' }
  );
  if (unitStatus !== 0) {
    process.exitCode = unitStatus;
    return;
  }

  const liveArgs = [
    path.join(ROOT_DIRECTORY, 'exporter', 'historical', 'test', 'liveNavigationSmoke.js'),
    '--strict',
    `--seed=${options.seed}`,
    `--limit=${options.limit}`,
    `--clicks=${options.clicks}`,
    `--report=${reportPath}`,
  ];
  const liveStatus = runStep('running strict live browser health check', process.execPath, liveArgs);
  if (liveStatus !== 0) {
    process.exitCode = liveStatus;
    return;
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  console.log(
    JSON.stringify(
      {
        reportPath,
        summary: report.summary,
      },
      null,
      2
    )
  );
}

main();
