import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const platform = process.argv[2] || ({ darwin: 'mac', win32: 'win' })[process.platform];
if (platform === 'mac' || platform === 'win') {
  const root = 'release';
  const installer = platform === 'mac' ? /\.(dmg|zip)$/i : /\.exe$/i;
  const unpacked = platform === 'mac' ? /^mac(?:-(arm64|x64|universal))?$/ : /^win(?:-(arm64|ia32|x64))?-unpacked$/;
  const entries = async dir => readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const hasInstaller = files => files.some(file => file.isFile() && installer.test(file.name));
  if (hasInstaller(await entries(path.join(root, version, platform)))) {
    for (const build of await entries(root)) {
      if (!build.isDirectory() || build.name === version || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(build.name)) continue;
      const folder = path.join(root, build.name, platform);
      const files = await entries(folder);
      if (!hasInstaller(files)) continue;
      for (const file of files) {
        if (file.isDirectory() && unpacked.test(file.name)) {
          await rm(path.join(folder, file.name), { recursive: true });
        }
      }
    }
  }
}
