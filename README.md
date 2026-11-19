# cline-bash-timeout

The standalone Cline CLI (`npm i -g cline`) stops every command the agent runs
after **30 s** and reports it as `Command failed: ... timed out after 30000ms`
([cline/cline#10549](https://github.com/cline/cline/issues/10549)). There is no
setting for this, so this tool patches the default inside the installed binary.

Plain Node, no dependencies. Works on Windows, WSL/Linux and macOS.

## Install

```bash
npm i -g ./cline-bash-timeout-1.0.0.tgz      # or: npm i -g <path-to-this-folder>
```

## Use

Close all Cline sessions first, then:

```bash
cline-bash-timeout                 # set to 1 hour (default)
cline-bash-timeout -t 10m          # 600, 600s, 10m, 1h, 2h30m all work (bare number = seconds)
cline-bash-timeout --status        # show current value
cline-bash-timeout --restore       # back to 30 s
cline-bash-timeout --dry-run -t 2h
cline-bash-timeout -b <path>       # patch a specific binary
```

Permissions:
- **Linux/WSL** with npm under `/usr/lib`: run with `sudo` (`sudo cline-bash-timeout -t 1h`).
- **Windows**: npm's global folder is under `%APPDATA%`, so a normal shell usually works.
  If you get `EPERM`/`EBUSY`, Cline is still running. Close it (check Task Manager for `cline.exe`).

**Run it again after every Cline update**, because `npm i -g cline` replaces the binary.
WSL and Windows have separate Cline installs, so patch each one.

## How it works

The CLI is a Bun-compiled executable with its JS bundle embedded as plain text.
The tool finds the binary the same way Cline's own `bin/cline` wrapper does
(`CLINE_BIN_PATH`, `cline/bin/.cline`, `@cline/cli-<os>-<arch>`), then rewrites
the `30000` literal in two places:

- `bashTimeoutMs??30000`: the `run_commands` tool's default
- `{shell:…,timeoutMs:X=30000,env:…}`: the shell executor's default

The web-fetch tool's 30 s timeout is left alone. The replacement must keep the same byte
length, so values are written as 5-character JS numbers (`360e4` = 1 h). A value
that can't be written exactly is rounded to 3 significant digits, and the tool
tells you when that happens. The maximum is about 24 days, which is the `setTimeout` limit.

The first patch saves a backup as `<binary>.orig`. `--restore` writes 30000 back,
or you can reinstall with `npm i -g cline`.

Tested with cline 3.0.74 on Linux x64. In a `sleep 40` test the original binary times
out at 30000ms and the patched one completes.

## Caveats

- This is an unofficial binary patch. If a new Cline version changes the code, the tool
  prints `no timeout patterns found` and does nothing.
- macOS: if the patched binary won't start, re-sign it: `codesign --force --sign - <binary>`.
- Windows: if Smart App Control / AppLocker blocks the modified `cline.exe`,
  run `--restore` (or reinstall).
- Commands that really run longer than the timeout are still killed. Set the timeout
  above your longest build or test run.
