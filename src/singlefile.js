'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Thin wrapper around the SingleFile CLI (single-file-cli npm package).
 * SingleFile drives a real Chromium-based browser over CDP and emits one
 * self-contained HTML file per page (styles, images and fonts inlined).
 */

/**
 * Locate the SingleFile entry script/binary, in priority order:
 *  1. explicit path (SINGLEFILE_PATH in .env)
 *  2. the locally installed single-file-cli package
 *  3. `single-file` on PATH (last resort)
 *
 * Returns { command, prefixArgs } suitable for child_process.spawn.
 */
function resolveSingleFile(explicitPath) {
  // Injected into every Node-hosted SingleFile process so that simple-cdp's
  // CloseEvent usage works on Node v22 (CloseEvent landed in Node v23).
  const polyfill = path.join(__dirname, 'closeevent-polyfill.js');
  const requirePolyfill = ['--require', polyfill];

  if (explicitPath) {
    if (/\.(c|m)?js$/i.test(explicitPath)) {
      return { command: process.execPath, prefixArgs: [...requirePolyfill, explicitPath] };
    }
    return { command: explicitPath, prefixArgs: [] };
  }

  try {
    const pkgPath = require.resolve('single-file-cli/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const binRelative =
      typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin['single-file'];
    if (binRelative) {
      const script = path.join(path.dirname(pkgPath), binRelative);
      return { command: process.execPath, prefixArgs: [...requirePolyfill, script] };
    }
  } catch {
    /* fall through to PATH lookup */
  }

  return { command: 'single-file', prefixArgs: [], fromPath: true };
}

/**
 * Archive one URL to `outputPath` as standalone HTML.
 * Resolves with { ok, error?, durationMs } — never rejects.
 */
async function savePage(url, outputPath, config) {
  const { command, prefixArgs, fromPath } = resolveSingleFile(
    config.singlefile.executablePath
  );

  const args = [
    ...prefixArgs,
    url,
    outputPath,
    '--filename-conflict-action=overwrite',
    `--browser-load-max-time=${config.timeoutMs}`,
    `--browser-capture-max-time=${config.timeoutMs}`,
    `--user-agent=${config.userAgent}`,
  ];
  if (config.singlefile.browserExecutablePath) {
    args.push(`--browser-executable-path=${config.singlefile.browserExecutablePath}`);
  }
  args.push(...config.singlefile.extraArgs);

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A bare command name (PATH lookup) needs the shell on Windows.
      shell: Boolean(fromPath) && process.platform === 'win32',
    });

    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    // Hard kill switch in case the browser wedges past its own timeouts.
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, config.timeoutMs * 2 + 30_000);

    const finish = (result) => {
      clearTimeout(killTimer);
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    child.on('error', (error) => {
      const hint =
        error.code === 'ENOENT'
          ? ' (SingleFile CLI not found — run `npm install` or set SINGLEFILE_PATH in .env)'
          : '';
      finish({ ok: false, error: `failed to launch SingleFile: ${error.message}${hint}` });
    });

    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        finish({ ok: true });
      } else {
        const detail = (stderr || stdout).trim().split('\n').slice(-3).join(' | ');
        finish({
          ok: false,
          error:
            code === 0
              ? 'SingleFile exited cleanly but produced no output file'
              : `SingleFile exited with code ${code}${detail ? `: ${detail}` : ''}`,
        });
      }
    });
  });
}

module.exports = { savePage, resolveSingleFile };
