import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function existsDirectory(path) {
  try { return (await stat(path)).isDirectory(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function configureLocalToolchainEnvironment(env = process.env, hostHome = homedir()) {
  for (const [name, directory] of [['RUSTUP_HOME', '.rustup'], ['CARGO_HOME', '.cargo']]) {
    const path = join(hostHome, directory);
    if (!env[name] && await existsDirectory(path)) env[name] = path;
  }
  if (!env.DOCKER_HOST) {
    const configRoot = env.DOCKER_CONFIG || join(hostHome, '.docker');
    const config = await optionalJson(join(configRoot, 'config.json'));
    const context = env.DOCKER_CONTEXT || config?.currentContext;
    if (context && context !== 'default') {
      const metaRoot = join(configRoot, 'contexts', 'meta');
      const directories = await existsDirectory(metaRoot) ? await readdir(metaRoot) : [];
      for (const directory of directories) {
        const metadata = await optionalJson(join(metaRoot, directory, 'meta.json'));
        const host = metadata?.Endpoints?.docker?.Host;
        if (metadata?.Name === context && typeof host === 'string' && host.startsWith('unix://')) {
          env.DOCKER_HOST = host;
          delete env.DOCKER_CONTEXT;
          break;
        }
      }
    }
  }
  return env;
}
