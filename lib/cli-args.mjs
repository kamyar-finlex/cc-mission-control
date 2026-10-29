// Command-line parsing for bin/cli.mjs: one command, known options only, a valid port.

export const COMMANDS = ['start', 'open', 'setup', 'uninstall', 'usage-task'];
const FLAGS = new Set(['no-open', 'no-service', 'help', 'version']);
const SHORT = { h: 'help', v: 'version' };

export const USAGE = `Usage: cc-mission-control [command] [options]

Commands:
  start         start the dashboard and open it in the browser (default)
  open          open the running dashboard, signed in
  setup         always-on service (macOS), status line, skill and usage-task instructions
  uninstall     remove the always-on service
  usage-task    print the message that creates the usage task

Options:
  --port <n>    port to use (default 7777, or $PORT)
  --no-open     start without opening the browser
  --no-service  setup without the always-on service
  -h, --help    show this help
  -v, --version show the version`;

export function parsePort(value) {
  const s = String(value);
  if (!/^\d{1,5}$/.test(s) || Number(s) < 1 || Number(s) > 65535) throw new Error(`Not a valid port: ${s}`);
  return Number(s);
}

// Returns { cmd, port, flags: Set }. Throws an Error with a message for the user on bad input.
export function parseArgs(argv, env = {}) {
  let cmd;
  let port = env.PORT ? parsePort(env.PORT) : 7777;
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a.startsWith('--port=')) {
      const value = a === '--port' ? argv[++i] : a.slice('--port='.length);
      if (value === undefined || value.startsWith('-')) throw new Error('--port needs a number, for example --port 7788');
      port = parsePort(value);
    } else if (a.startsWith('--')) {
      if (!FLAGS.has(a.slice(2))) throw new Error(`Unknown option: ${a}`);
      flags.add(a.slice(2));
    } else if (/^-[a-z]$/.test(a)) {
      if (!SHORT[a[1]]) throw new Error(`Unknown option: ${a}`);
      flags.add(SHORT[a[1]]);
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      if (cmd) throw new Error(`Unexpected argument: ${a}`);
      if (!COMMANDS.includes(a)) throw new Error(`Unknown command: ${a}`);
      cmd = a;
    }
  }
  return { cmd: cmd || 'start', port, flags };
}
