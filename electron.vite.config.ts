import { configureInstance } from './scripts/instance-config.mjs';
import { resolve } from 'node:path';
import { createReadStream, readFileSync } from 'node:fs';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const defaultVrm = resolve(__dirname, 'models/AvatarSample_A.vrm');

/** 不依賴 src/renderer/public 的 symlink；Windows checkout 也能得到真正的 VRM。 */
function defaultVrmPlugin(): Plugin {
  return {
    name: 'default-vrm',
    configureServer(server) {
      server.middlewares.use('/AvatarSample_A.vrm', (_request, response) => {
        response.setHeader('Content-Type', 'model/gltf-binary');
        createReadStream(defaultVrm).pipe(response);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'AvatarSample_A.vrm',
        source: readFileSync(defaultVrm),
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  main: {
    build: {
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
      rollupOptions: { external: ['electron', 'better-sqlite3'] }
    }
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') },
      rollupOptions: { external: ['electron', 'better-sqlite3'] }
    }
  },
  renderer: {
    server: command === 'serve' ? { host: '127.0.0.1', port: configureInstance(), strictPort: true } : undefined,
    root: resolve(__dirname, 'src/renderer'),
    publicDir: false,
    plugins: [defaultVrmPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          control: resolve(__dirname, 'src/renderer/control.html'),
          prompt: resolve(__dirname, 'src/renderer/prompt.html'),
          petHouse: resolve(__dirname, 'src/renderer/petHouse.html')
        }
      }
    }
  }
}));
