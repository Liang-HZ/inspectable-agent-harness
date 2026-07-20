// macOS Seatbelt SBPL profile builder for the agent shell tool.
//
// This module is pure: it only produces SBPL profile strings. It does not
// touch `process.env`, `process.cwd()`, or `child_process`. The shell sandbox
// resolver (`agent-shell-sandbox.ts`) feeds these profiles to
// `/usr/bin/sandbox-exec -p <profile> -D NAME=VALUE ... -- bash -c <command>`.
//
// The profile structure follows OpenAI Codex's `codex-rs/sandboxing/` Seatbelt
// files (seatbelt_base_policy.sbpl + restricted_read_only_platform_defaults.sbpl),
// adapted to this project's two sandbox modes (read_only / workspace_write)
// and its carveout list (.git, .env, data/agent-sessions, ...). The network
// policy is "none" in both sandboxed modes: `(deny default)` already blocks
// every network operation class, so omitting all `(allow network-*)` rules
// is the denial. danger_full_access never reaches this module: the resolver
// returns a raw `bash -c` argv for that mode without consulting the OS sandbox.

// Carveout subpaths that stay read-only inside a writable project root.
// Kept here (not in the resolver) because the SBPL template needs to emit one
// `require-not` pair per carveout, and the list is SBPL-specific: it is the
// set of project-relative paths the model must not rewrite even when the run
// policy grants workspace write. The resolver re-exports this list for the
// Linux bwrap path so both platforms carve out the same directories.
export const MACOS_SANDBOX_READONLY_CARVEOUTS = [
  '.git',
  'data/agent-sessions',
  '.env',
  '.env.local',
  'node_modules',
  '.next',
] as const;

// Base policy: closed-by-default + the minimum process/signal/sysctl/mach/pty
// primitives that bash and the OS runtime need to start at all. Without these,
// `(deny default)` blocks process-fork, signal delivery, sysctl reads (Node's
// `os.cpus()` probes `hw.*`), and Mach service lookups (TLS, cfprefsd).
//
// `(allow process-exec)` is unconditional: Seatbelt gates "what can be
// executed" through file-read/file-map-executable on the binary, not through
// process-exec itself. The platform-defaults section below re-allows reading
// /bin, /usr/bin, /usr/lib, ... so bash, ls, grep, git, etc. can be loaded.
export const MACOS_SEATBELT_BASE_SBPL = `(version 1)
; start with closed-by-default
(deny default)

; child processes inherit the policy of their parent
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

; /dev/null write carveout: many tools write to /dev/null by default
(allow file-write-data
  (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))

; sysctls: Node's os.cpus(), bash, and many tools probe hw.*/kern.* names.
; Allowlist the specific names rather than (allow sysctl-read) so a new
; kernel probe can't quietly widen access.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.model")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable."))

; Mach services: TLS trustd, cfprefsd (user preferences), opendirectoryd
; (user info lookups). Without these, TLS handshakes stall and basic
; user-info lookups fail.
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow ipc-posix-sem)
(allow user-preference-read)
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))

; PTY: interactive shells and tools that probe for a TTY need these.
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
; PTYs created before entering seatbelt may lack the extension.
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
`;

// Platform defaults: read access to the system runtime so exec works.
// bash needs to mmap its own binary and dyld needs to load shared libs.
// `file-map-executable` is its own operation class, separate from file-read*,
// so it must be explicitly allowed or `(deny default)` blocks dyld.
export const MACOS_SEATBELT_PLATFORM_DEFAULTS_SBPL = `;
; --- platform defaults: exec, libs, /etc, /dev, /tmp ---

; System binaries: bash, ls, grep, git, etc. live under /bin, /usr/bin,
; /usr/libexec, /sbin, /usr/sbin. Allow read + metadata only.
(allow file-read-data (subpath "/bin"))
(allow file-read-metadata (subpath "/bin"))
(allow file-read-data (subpath "/sbin"))
(allow file-read-metadata (subpath "/sbin"))
(allow file-read-data (subpath "/usr/bin"))
(allow file-read-metadata (subpath "/usr/bin"))
(allow file-read-data (subpath "/usr/sbin"))
(allow file-read-metadata (subpath "/usr/sbin"))
(allow file-read-data (subpath "/usr/libexec"))
(allow file-read-metadata (subpath "/usr/libexec"))

; System libraries and frameworks: needed by dyld for every exec.
(allow file-read* (subpath "/usr/lib"))
(allow file-read* (subpath "/usr/share"))
(allow file-map-executable
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/usr/lib"))

; Homebrew libs (Apple Silicon uses /opt/homebrew, Intel uses /usr/local).
(allow file-read* (subpath "/opt/homebrew/lib"))
(allow file-read* (subpath "/usr/local/lib"))

; Device nodes: /dev/null, /dev/zero, /dev/urandom, /dev/random.
(allow file-read* file-test-existence
  (literal "/dev/random")
  (literal "/dev/urandom"))
(allow file-read* file-test-existence file-write-data
  (literal "/dev/null")
  (literal "/dev/zero"))
(allow file-read* file-write* (literal "/dev/tty"))
(allow file-read-metadata (literal "/dev"))

; stdio fds (0/1/2) are passed in by the parent; allow read/write on them.
(allow file-read* (regex "^/dev/fd/(0|1|2)$"))
(allow file-write* (regex "^/dev/fd/(1|2)$"))

; Temp dirs: many tools write to /tmp. /tmp on macOS is a symlink to
; /private/tmp, so both must be allowed.
(allow file-read* file-test-existence file-write* (subpath "/tmp"))
(allow file-read* file-write* (subpath "/private/tmp"))
(allow file-read* file-write* (subpath "/var/tmp"))
(allow file-read* file-write* (subpath "/private/var/tmp"))

; System config: /etc/ssl/cert.pem (curl/git TLS), /etc/passwd, /etc/hosts.
; /etc is a symlink to /private/etc on macOS, so allow both.
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/private/etc"))
(allow file-read* file-test-existence
  (literal "/private/etc/passwd")
  (literal "/private/etc/protocols")
  (literal "/private/etc/services")
  (literal "/private/etc/master.passwd"))
(allow file-read-metadata file-test-existence
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (literal "/private/etc/localtime"))

; Root directory listing.
(allow file-read* file-test-existence (literal "/"))
`;

// Writable-root template. Each carveout gets a `require-not` pair:
//   (require-not (literal <carveout>))   ; block the dir itself
//   (require-not (subpath <carveout>))   ; block everything under it
// `subpath` alone leaves a gap for first-time creation of the carveout
// (e.g. `mkdir .git`), so `literal` is added to close that hole. This mirrors
// Codex's seatbelt.rs comment on WRITABLE_ROOT_0_EXCLUDED_0.
//
// Paths are injected via `(param "NAME")` and resolved at sandbox-exec load
// time through `-D NAME=VALUE` on the command line. This avoids string-
// splicing absolute paths into the profile and sidesteps quoting issues.
function buildWritableRootSbplSection(
  writableRootParam: string,
  carveoutParams: string[],
  allowWrite: boolean,
): string {
  const lines: string[] = [
    '',
    '; --- project root ---',
    `(allow file-read* (subpath (param "${writableRootParam}")))`,
  ];

  if (allowWrite) {
    const requireNotClauses = carveoutParams
      .map(
        (carveoutParam) =>
          `    (require-not (literal (param "${carveoutParam}")))\n    (require-not (subpath (param "${carveoutParam}")))`,
      )
      .join('\n');

    if (requireNotClauses === '') {
      lines.push(
        `(allow file-write* (subpath (param "${writableRootParam}")))`,
      );
    } else {
      lines.push(
        `(allow file-write*`,
        `  (require-all`,
        `    (subpath (param "${writableRootParam}"))`,
        requireNotClauses,
        `  )`,
        `)`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export type MacosSbplProfileInput = {
  // Absolute path of the project root, the only writable (or readable) root
  // outside the platform defaults.
  writableRoot: string;
  // Project-relative carveout paths (e.g. ['.git', 'data/agent-sessions']).
  // Each becomes a `-D` parameter and a `require-not` pair in the profile.
  carveouts: readonly string[];
  // workspace_write -> true (read + write with carveouts)
  // read_only      -> false (read only, no write allow rule at all)
  allowWrite: boolean;
};

export type MacosSbplProfile = {
  // The SBPL profile string to pass to `sandbox-exec -p`.
  profile: string;
  // The `-D NAME=VALUE` arguments to pass to sandbox-exec, in order.
  // The first entry is always WRITABLE_ROOT_0=<writableRoot>; each carveout
  // appends WRITABLE_ROOT_0_EXCLUDED_<N>=<writableRoot>/<carveout>.
  definitions: string[];
};

export function buildMacosSbplProfile(
  input: MacosSbplProfileInput,
): MacosSbplProfile {
  const definitions: string[] = [`WRITABLE_ROOT_0=${input.writableRoot}`];

  const carveoutParams: string[] = [];
  input.carveouts.forEach((carveout, index) => {
    const paramName = `WRITABLE_ROOT_0_EXCLUDED_${index}`;
    const carveoutAbs = `${input.writableRoot}/${carveout}`;
    definitions.push(`${paramName}=${carveoutAbs}`);
    carveoutParams.push(paramName);
  });

  const writableSection = buildWritableRootSbplSection(
    'WRITABLE_ROOT_0',
    carveoutParams,
    input.allowWrite,
  );

  const profile = [
    MACOS_SEATBELT_BASE_SBPL,
    MACOS_SEATBELT_PLATFORM_DEFAULTS_SBPL,
    writableSection,
    '; --- network: NONE (deny default already covers it) ---',
    '',
  ].join('');

  return {
    profile: profile,
    definitions: definitions,
  };
}
