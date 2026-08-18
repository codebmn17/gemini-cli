import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PINNED_GEMINI_CLI_VERSION = '0.55.1';
export const GEMINI_DIR = '.gemini';

export const SENSITIVE_ENV_KEYS = Object.freeze([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GEMINI_DEFAULT_AUTH_TYPE',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
]);

export const PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]);

export const CONTROL_ENV_KEYS = Object.freeze([
  'GEMINI_CLI_HOME',
  'GEMINI_CLI_TRUST_WORKSPACE',
  'GEMINI_CLI_TRUSTED_FOLDERS_PATH',
  'GEMINI_CLI_IDE_SERVER_PORT',
  'CLOUD_SHELL',
]);

const TRUST_LEVELS = new Set([
  'TRUST_FOLDER',
  'TRUST_PARENT',
  'DO_NOT_TRUST',
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function presenceMap(environment, keys) {
  return Object.fromEntries(keys.map((key) => [key, hasOwn(environment, key)]));
}

export function hasAnyPresence(presence) {
  return Object.values(presence).some(Boolean);
}

export function getGeminiHome(environment = process.env, osHome = os.homedir()) {
  return environment.GEMINI_CLI_HOME || osHome;
}

export function getNativeSystemPaths(platform = process.platform) {
  const pathModule = platform === 'win32' ? path.win32 : path;
  let systemSettings;
  if (platform === 'darwin') {
    systemSettings = '/Library/Application Support/GeminiCli/settings.json';
  } else if (platform === 'win32') {
    systemSettings = 'C:\\ProgramData\\gemini-cli\\settings.json';
  } else {
    systemSettings = '/etc/gemini-cli/settings.json';
  }
  return {
    systemSettings,
    systemDefaults: pathModule.join(
      pathModule.dirname(systemSettings),
      'system-defaults.json',
    ),
  };
}

/**
 * Remove // and block comments while preserving JSON string contents and line
 * breaks. This is intentionally small because Phase B only needs to read the
 * two boolean settings that influence trust/.env selection plus trust rules.
 */
export function stripJsonComments(input) {
  let output = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
        output += char;
      } else {
        output += ' ';
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        inBlockComment = false;
      } else if (char === '\n' || char === '\r') {
        output += char;
      } else {
        output += ' ';
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 1;
      inLineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      inBlockComment = true;
      continue;
    }

    output += char;
  }

  return output;
}

function isRegularFile(filePath, fsApi = fs) {
  try {
    return fsApi.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readJsonObject(filePath, fsApi = fs) {
  if (!fsApi.existsSync(filePath)) {
    return { status: 'absent', value: {} };
  }

  try {
    if (!isRegularFile(filePath, fsApi)) {
      return { status: 'invalid', value: {} };
    }
    const parsed = JSON.parse(stripJsonComments(fsApi.readFileSync(filePath, 'utf8')));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { status: 'invalid', value: {} };
    }
    return { status: 'ok', value: parsed };
  } catch {
    return { status: 'invalid', value: {} };
  }
}

function getNested(object, keys) {
  let cursor = object;
  for (const key of keys) {
    if (typeof cursor !== 'object' || cursor === null || !hasOwn(cursor, key)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

function readBooleanSetting(settings, keys, fallback) {
  const raw = getNested(settings, keys);
  if (raw === undefined) {
    return { status: 'default', value: fallback };
  }
  if (typeof raw !== 'boolean') {
    return { status: 'invalid', value: fallback };
  }
  return { status: 'set', value: raw };
}

function realPathIfPresent(location, fsApi = fs) {
  try {
    return fsApi.existsSync(location) ? fsApi.realpathSync(location) : location;
  } catch {
    return location;
  }
}

function normalizePathForPlatform(location, platform = process.platform) {
  const pathModule = platform === 'win32' ? path.win32 : path;
  const absolute = pathModule.resolve(location).replace(/\\/g, '/');
  return platform === 'win32' || platform === 'darwin'
    ? absolute.toLowerCase()
    : absolute;
}

function isSubpathForPlatform(parentPath, childPath, platform = process.platform) {
  const pathModule = platform === 'win32' ? path.win32 : path;
  let parent = pathModule.resolve(parentPath);
  let child = pathModule.resolve(childPath);
  if (platform === 'darwin') {
    parent = parent.toLowerCase();
    child = child.toLowerCase();
  }
  const relative = pathModule.relative(parent, child);
  return (
    !relative.startsWith(`..${pathModule.sep}`) &&
    relative !== '..' &&
    !pathModule.isAbsolute(relative)
  );
}

function sameLocation(left, right, fsApi = fs, platform = process.platform) {
  return (
    normalizePathForPlatform(realPathIfPresent(left, fsApi), platform) ===
    normalizePathForPlatform(realPathIfPresent(right, fsApi), platform)
  );
}

function loadTrustRules(filePath, fsApi = fs, platform = process.platform) {
  const result = readJsonObject(filePath, fsApi);
  if (result.status !== 'ok') {
    return result.status === 'absent'
      ? { status: 'absent', rules: {} }
      : { status: 'invalid', rules: {} };
  }

  const rules = {};
  for (const [rawPath, trustLevel] of Object.entries(result.value)) {
    if (!TRUST_LEVELS.has(trustLevel)) {
      return { status: 'invalid', rules: {} };
    }
    rules[normalizePathForPlatform(rawPath, platform)] = trustLevel;
  }
  return { status: 'ok', rules };
}

export function evaluateTrustRules(
  workspaceDir,
  rules,
  { fsApi = fs, platform = process.platform } = {},
) {
  const realWorkspace = realPathIfPresent(workspaceDir, fsApi);
  const normalizedWorkspace = normalizePathForPlatform(realWorkspace, platform);
  let longestMatchLength = -1;
  let longestMatchTrust;

  for (const [rulePath, trustLevel] of Object.entries(rules)) {
    const pathModule = platform === 'win32' ? path.win32 : path;
    const effectivePath =
      trustLevel === 'TRUST_PARENT' ? pathModule.dirname(rulePath) : rulePath;
    const realEffective = realPathIfPresent(effectivePath, fsApi);
    const normalizedEffective = normalizePathForPlatform(realEffective, platform);

    if (
      isSubpathForPlatform(normalizedEffective, normalizedWorkspace, platform) &&
      rulePath.length > longestMatchLength
    ) {
      longestMatchLength = rulePath.length;
      longestMatchTrust = trustLevel;
    }
  }

  if (longestMatchTrust === 'DO_NOT_TRUST') return false;
  if (
    longestMatchTrust === 'TRUST_FOLDER' ||
    longestMatchTrust === 'TRUST_PARENT'
  ) {
    return true;
  }
  return undefined;
}

function evaluateFolderTrust(
  folderTrustSettings,
  { workspaceDir, homeDir, environment, fsApi, platform },
) {
  if (environment.GEMINI_CLI_TRUST_WORKSPACE === 'true') {
    return { status: 'ok', isTrusted: true, source: 'env' };
  }

  const folderTrust = readBooleanSetting(
    folderTrustSettings,
    ['security', 'folderTrust', 'enabled'],
    true,
  );
  if (folderTrust.status === 'invalid') {
    return {
      status: 'blocked',
      isTrusted: false,
      source: 'settings-invalid',
      blocker: 'folder-trust-setting-invalid',
    };
  }
  if (!folderTrust.value) {
    return { status: 'ok', isTrusted: true, source: 'folder-trust-disabled' };
  }

  // Gemini can receive IDE trust through an in-memory store. A standalone
  // preflight cannot read that store, so fail closed whenever IDE trust may be
  // active instead of guessing. Preserve Gemini's trust precedence above: an
  // explicit trust override or disabled folder trust already determines trust.
  if (hasOwn(environment, 'GEMINI_CLI_IDE_SERVER_PORT')) {
    return {
      status: 'blocked',
      isTrusted: false,
      source: 'ide-undetermined',
      blocker: 'ide-trust-context-undetermined',
    };
  }

  const ideMode = readBooleanSetting(folderTrustSettings, ['ide', 'enabled'], false);
  if (ideMode.status === 'invalid') {
    return {
      status: 'blocked',
      isTrusted: false,
      source: 'settings-invalid',
      blocker: 'ide-mode-setting-invalid',
    };
  }
  if (ideMode.value) {
    return {
      status: 'blocked',
      isTrusted: false,
      source: 'ide-undetermined',
      blocker: 'ide-mode-enabled-in-settings',
    };
  }

  const trustPath = environment.GEMINI_CLI_TRUSTED_FOLDERS_PATH
    ? environment.GEMINI_CLI_TRUSTED_FOLDERS_PATH
    : path.join(homeDir, GEMINI_DIR, 'trustedFolders.json');
  const loaded = loadTrustRules(trustPath, fsApi, platform);
  if (loaded.status === 'invalid') {
    return {
      status: 'blocked',
      isTrusted: false,
      source: 'trusted-folders-invalid',
      blocker: 'trusted-folders-invalid',
    };
  }

  const trust = evaluateTrustRules(workspaceDir, loaded.rules, {
    fsApi,
    platform,
  });
  return {
    status: 'ok',
    isTrusted: trust ?? false,
    source: trust === undefined ? 'none' : 'file',
  };
}

/**
 * Gemini 0.55.1 only ever reads security.folderTrust.enabled and ide.enabled
 * while resolving trust, so those are the only two fields that need a
 * workspace-over-user merge here (matching mergeSettings()'s "defined key from
 * the later source wins" semantics for a single scalar field).
 */
function mergeFolderTrustSettings(userSettings, workspaceSettings) {
  const workspaceFolderTrust = getNested(
    workspaceSettings,
    ['security', 'folderTrust', 'enabled'],
  );
  const workspaceIdeEnabled = getNested(workspaceSettings, ['ide', 'enabled']);
  return {
    security: {
      folderTrust: {
        enabled:
          workspaceFolderTrust !== undefined
            ? workspaceFolderTrust
            : getNested(userSettings, ['security', 'folderTrust', 'enabled']),
      },
    },
    ide: {
      enabled:
        workspaceIdeEnabled !== undefined
          ? workspaceIdeEnabled
          : getNested(userSettings, ['ide', 'enabled']),
    },
  };
}

/**
 * Reproduces Gemini 0.55.1's two-stage trust bootstrap in
 * packages/cli/src/config/settings.ts:
 *
 * 1. `_doLoadSettings()` computes an initial ("bootstrap") trust result from
 *    settings layers that exclude workspace settings (schema defaults, system
 *    defaults, user, system), and uses only that boolean to decide whether
 *    workspace settings are allowed into `mergeSettings()` at all.
 * 2. `loadEnvironment()` then calls `isWorkspaceTrusted()` a second time using
 *    the fully merged settings (which now may include workspace's own
 *    `security.folderTrust.enabled`/`ide.enabled` if bootstrap trust was
 *    true), and *that* second result is what `findEnvFile()` actually uses.
 *
 * These two results can differ: a user can globally disable folder trust
 * while a workspace re-enables it with no matching trustedFolders rule, in
 * which case bootstrap trust is true (workspace settings participate) but the
 * re-derived trust used for `.env` selection is false. Native/system-settings
 * layers are already fail-closed earlier in this preflight, so stage 1 here
 * only needs schema defaults (baked into evaluateFolderTrust's fallbacks) plus
 * user settings.
 */
export function resolveWorkspaceTrust({
  workspaceDir,
  homeDir,
  environment = process.env,
  userSettings = {},
  workspaceSettings = {},
  fsApi = fs,
  platform = process.platform,
}) {
  const bootstrap = evaluateFolderTrust(userSettings, {
    workspaceDir,
    homeDir,
    environment,
    fsApi,
    platform,
  });

  if (bootstrap.status !== 'ok' || !bootstrap.isTrusted) {
    // Workspace settings never enter Gemini's merge unless bootstrap trust is
    // true, so there is no second stage to run here: the bootstrap result is
    // also the final trust value used for .env selection.
    return { ...bootstrap, workspaceSettingsParticipate: false };
  }

  const finalTrust = evaluateFolderTrust(
    mergeFolderTrustSettings(userSettings, workspaceSettings),
    { workspaceDir, homeDir, environment, fsApi, platform },
  );
  return { ...finalTrust, workspaceSettingsParticipate: true };
}

export function findSelectedEnvFile(
  workspaceDir,
  {
    homeDir,
    isTrusted,
    ignoreLocalEnv,
    fsApi = fs,
  },
) {
  let currentDir = path.resolve(workspaceDir);
  while (true) {
    if (isTrusted) {
      const geminiEnvPath = path.join(currentDir, GEMINI_DIR, '.env');
      if (fsApi.existsSync(geminiEnvPath)) {
        return geminiEnvPath;
      }
    }

    const envPath = path.join(currentDir, '.env');
    if (fsApi.existsSync(envPath)) {
      if (!ignoreLocalEnv || currentDir === homeDir) {
        return envPath;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || !parentDir) {
      if (isTrusted) {
        const homeGeminiEnvPath = path.join(homeDir, GEMINI_DIR, '.env');
        if (fsApi.existsSync(homeGeminiEnvPath)) {
          return homeGeminiEnvPath;
        }
      }
      const homeEnvPath = path.join(homeDir, '.env');
      if (fsApi.existsSync(homeEnvPath)) {
        return homeEnvPath;
      }
      return null;
    }
    currentDir = parentDir;
  }
}

export function classifyEnvSource(filePath, homeDir) {
  if (!filePath) return 'none';
  const resolved = path.resolve(filePath);
  const homeGemini = path.resolve(homeDir, GEMINI_DIR, '.env');
  const homeEnv = path.resolve(homeDir, '.env');
  if (resolved === homeGemini) return 'home-gemini-env';
  if (resolved === homeEnv) return 'home-env';
  if (path.basename(path.dirname(resolved)) === GEMINI_DIR) {
    return 'workspace-gemini-env';
  }
  return 'generic-env';
}

function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Extract dotenv key names without retaining values. Quoted multiline values
 * are tracked so a line that merely looks like KEY=value inside a value is not
 * mistaken for a second variable.
 */
export function scanDotenvKeys(content) {
  const keys = new Set();
  let multilineQuote = null;

  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (multilineQuote) {
      for (let index = 0; index < rawLine.length; index += 1) {
        if (rawLine[index] === multilineQuote && !isEscaped(rawLine, index)) {
          multilineQuote = null;
          break;
        }
      }
      continue;
    }

    let line = rawLine.trimStart();
    if (!line || line.startsWith('#')) continue;
    if (/^export\s+/.test(line)) {
      line = line.replace(/^export\s+/, '');
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*(=|:\s+)/);
    if (!match) continue;
    const key = match[1];
    keys.add(key);

    const valueStart = line.slice(match[0].length).trimStart();
    const quote = valueStart[0];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;

    let closed = false;
    for (let index = 1; index < valueStart.length; index += 1) {
      if (valueStart[index] === quote && !isEscaped(valueStart, index)) {
        closed = true;
        break;
      }
    }
    if (!closed) multilineQuote = quote;
  }

  return keys;
}

function selectedEnvPresence(filePath, fsApi = fs) {
  if (!filePath) {
    return {
      status: 'none',
      sensitive: presenceMap({}, SENSITIVE_ENV_KEYS),
      proxy: presenceMap({}, PROXY_ENV_KEYS),
    };
  }

  try {
    if (!isRegularFile(filePath, fsApi)) {
      return {
        status: 'invalid',
        sensitive: presenceMap({}, SENSITIVE_ENV_KEYS),
        proxy: presenceMap({}, PROXY_ENV_KEYS),
      };
    }
    const keys = scanDotenvKeys(fsApi.readFileSync(filePath, 'utf8'));
    const keyObject = Object.fromEntries([...keys].map((key) => [key, true]));
    return {
      status: 'ok',
      sensitive: presenceMap(keyObject, SENSITIVE_ENV_KEYS),
      proxy: presenceMap(keyObject, PROXY_ENV_KEYS),
    };
  } catch {
    return {
      status: 'invalid',
      sensitive: presenceMap({}, SENSITIVE_ENV_KEYS),
      proxy: presenceMap({}, PROXY_ENV_KEYS),
    };
  }
}

function addBlocker(blockers, blocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

export function runPhaseBPreflight({
  workspaceDir = process.cwd(),
  environment = process.env,
  fsApi = fs,
  platform = process.platform,
  osHome = os.homedir(),
  nativePaths = getNativeSystemPaths(platform),
} = {}) {
  const blockers = [];
  const homeDir = getGeminiHome(environment, osHome);
  const inheritedSensitive = presenceMap(environment, SENSITIVE_ENV_KEYS);
  const inheritedProxy = presenceMap(environment, PROXY_ENV_KEYS);
  const controlEnv = presenceMap(environment, CONTROL_ENV_KEYS);

  const nativePolicy = {
    systemSettings: {
      path: nativePaths.systemSettings,
      present: fsApi.existsSync(nativePaths.systemSettings),
    },
    systemDefaults: {
      path: nativePaths.systemDefaults,
      present: fsApi.existsSync(nativePaths.systemDefaults),
    },
  };

  if (nativePolicy.systemSettings.present) addBlocker(blockers, 'native-system-settings-present');
  if (nativePolicy.systemDefaults.present) addBlocker(blockers, 'native-system-defaults-present');
  if (inheritedSensitive.GEMINI_CLI_SYSTEM_SETTINGS_PATH) {
    addBlocker(blockers, 'system-settings-override-present');
  }
  if (inheritedSensitive.GEMINI_CLI_SYSTEM_DEFAULTS_PATH) {
    addBlocker(blockers, 'system-defaults-override-present');
  }
  if (hasAnyPresence(inheritedProxy)) addBlocker(blockers, 'inherited-proxy-present');
  if (environment.CLOUD_SHELL === 'true') {
    addBlocker(blockers, 'cloud-shell-context-unsupported');
  }

  const baselineUnknown = blockers.some((blocker) =>
    blocker.startsWith('native-system-') || blocker.startsWith('system-'),
  );

  let workspaceTrust = {
    status: 'blocked',
    isTrusted: false,
    source: 'undetermined',
    workspaceSettingsParticipate: false,
  };
  let ignoreLocalEnv = { status: 'undetermined', value: null };
  let selectedEnv = {
    status: 'undetermined',
    source: 'undetermined',
    sensitive: presenceMap({}, SENSITIVE_ENV_KEYS),
    proxy: presenceMap({}, PROXY_ENV_KEYS),
  };

  if (!baselineUnknown) {
    const userSettingsPath = path.join(homeDir, GEMINI_DIR, 'settings.json');
    const user = readJsonObject(userSettingsPath, fsApi);
    if (user.status === 'invalid') addBlocker(blockers, 'user-settings-invalid');

    const workspaceIsHome = sameLocation(workspaceDir, homeDir, fsApi, platform);
    const workspaceSettingsPath = path.join(workspaceDir, GEMINI_DIR, 'settings.json');
    const workspace = workspaceIsHome
      ? { status: 'absent', value: {} }
      : readJsonObject(workspaceSettingsPath, fsApi);
    if (workspace.status === 'invalid') addBlocker(blockers, 'workspace-settings-invalid');

    if (user.status !== 'invalid' && workspace.status !== 'invalid') {
      workspaceTrust = resolveWorkspaceTrust({
        workspaceDir,
        homeDir,
        environment,
        userSettings: user.value,
        workspaceSettings: workspace.value,
        fsApi,
        platform,
      });
      if (workspaceTrust.status === 'blocked' && workspaceTrust.blocker) {
        addBlocker(blockers, workspaceTrust.blocker);
      }

      if (workspaceTrust.status === 'ok') {
        // Workspace's own advanced.ignoreLocalEnv participates in the merge
        // based on bootstrap (stage 1) trust, not the re-derived (stage 2)
        // trust used for .gemini/.env selection below -- this mirrors
        // loadEnvironment() reading ignoreLocalEnv off the already-merged
        // tempMergedSettings rather than re-deriving it.
        const userIgnore = readBooleanSetting(
          user.value,
          ['advanced', 'ignoreLocalEnv'],
          false,
        );
        const workspaceIgnore = readBooleanSetting(
          workspace.value,
          ['advanced', 'ignoreLocalEnv'],
          userIgnore.value,
        );
        if (userIgnore.status === 'invalid') {
          addBlocker(blockers, 'user-ignore-local-env-invalid');
        }
        if (
          workspaceTrust.workspaceSettingsParticipate &&
          workspaceIgnore.status === 'invalid'
        ) {
          addBlocker(blockers, 'workspace-ignore-local-env-invalid');
        }

        if (
          userIgnore.status !== 'invalid' &&
          (!workspaceTrust.workspaceSettingsParticipate ||
            workspaceIgnore.status !== 'invalid')
        ) {
          const effectiveIgnore = workspaceTrust.workspaceSettingsParticipate
            ? workspaceIgnore.value
            : userIgnore.value;
          ignoreLocalEnv = { status: 'ok', value: effectiveIgnore };
          const selectedPath = findSelectedEnvFile(workspaceDir, {
            homeDir,
            isTrusted: workspaceTrust.isTrusted,
            ignoreLocalEnv: effectiveIgnore,
            fsApi,
          });
          const selectedPresence = selectedEnvPresence(selectedPath, fsApi);
          selectedEnv = {
            ...selectedPresence,
            source: classifyEnvSource(selectedPath, homeDir),
          };
          if (selectedPresence.status === 'invalid') {
            addBlocker(blockers, 'selected-env-read-error');
          }
          if (hasAnyPresence(selectedEnv.proxy)) {
            addBlocker(blockers, 'selected-env-proxy-present');
          }
        }
      }
    }
  }

  return {
    schemaVersion: 1,
    pinnedGeminiCliVersion: PINNED_GEMINI_CLI_VERSION,
    allowed: blockers.length === 0,
    blockers,
    nativePolicy,
    inherited: {
      sensitive: inheritedSensitive,
      proxy: inheritedProxy,
      control: controlEnv,
    },
    workspaceTrust: {
      status: workspaceTrust.status,
      isTrusted: workspaceTrust.isTrusted,
      source: workspaceTrust.source,
      workspaceSettingsParticipate: workspaceTrust.workspaceSettingsParticipate ?? false,
    },
    ignoreLocalEnv,
    selectedEnv,
  };
}
