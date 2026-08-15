// Tiny argv parser shared by every runner.
// Supports: --key value, --key=value, and boolean --flag.

export function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      parsed[key] = argv[i + 1];
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

export function splitArg(value, fallback) {
  if (!value || value === true) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// "latest=6.8.0,next-7=next-7" -> { latest: '6.8.0', 'next-7': 'next-7' }
export function parseVersions(value, fallback) {
  if (!value || value === true) return fallback;
  return Object.fromEntries(
    value.split(',').map((entry) => {
      const [label, spec] = entry.split('=', 2);
      return [label.trim(), (spec ?? label).trim()];
    })
  );
}
