import { homedir } from 'node:os';
import { join } from 'node:path';

/** Finder 啟動不會讀取 shell 設定；補上常見 CLI 安裝位置並保留原 PATH 優先順序。 */
export function configureCliEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): void {
  if (platform !== 'darwin') return;
  const paths = [
    ...(env.PATH ?? '').split(':').filter(Boolean),
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  env.PATH = [...new Set(paths)].join(':');
}
