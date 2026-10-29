// Arguments for the `claude` CLI. User text always goes after `--`, so a reply that starts
// with "- item" or "--some-flag" is a prompt, never an option.

// The modes the New agent dialog offers. bypassPermissions and dontAsk are refused: a request
// to this server must never be able to start an agent that skips its permission prompts.
export const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'manual', 'plan']);
// An alias (opus, sonnet, haiku, fable) or a full model id; never something that reads as an option.
export const MODEL_RE = /^[a-z][a-z0-9.-]{0,79}(\[1m\])?$/i;

export function dispatchArgs({ model, permissionMode, prompt }) {
  const args = ['--bg'];
  if (model) {
    if (!MODEL_RE.test(String(model))) return { error: `Unknown model: ${String(model).slice(0, 80)}` };
    args.push('--model', String(model));
  }
  if (permissionMode) {
    if (!PERMISSION_MODES.has(String(permissionMode))) return { error: `Permission mode not allowed from the console: ${String(permissionMode).slice(0, 40)}` };
    args.push('--permission-mode', String(permissionMode));
  }
  args.push('--', prompt);
  return { args };
}

export const continueArgs = (sessionId, text) => ['--bg', '--resume', sessionId, '--', text];
