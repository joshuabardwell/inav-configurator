import { defineConfig } from 'vite';
import { pluginExposeRenderer } from './vite.base.config';
import inject from '@rollup/plugin-inject';

export default defineConfig((env) => {
  /** @type {import('vite').ConfigEnv<'renderer'>} */
  const forgeEnv = env;
  const { root, mode, forgeConfigSelf } = forgeEnv;
  const name = forgeConfigSelf.name ?? '';

  /** @type {import('vite').UserConfig} */
  return {
    root,
    mode,
    base: './',
    publicDir: 'node_modules/cesium/Build/Cesium',
    assetsInclude: ['**/*.gltf', '**/*.glb'],
    build: {
      outDir: `.vite/renderer/${name}`,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      chunkSizeWarningLimit: 10240,
    },
    plugins: [
      inject({
        $: 'jquery',
        jQuery: 'jquery',        
      }),
      pluginExposeRenderer(name)],
    resolve: {
      preserveSymlinks: true,
    },
    // JB's fork: the Configurator's own build label (js/forkBuildLabel.js), set by the
    // packaging step from tools/build_label.sh. Empty here shows as "jb-dev".
    define: {
      __JB_BUILD_LABEL__: JSON.stringify(process.env.JB_BUILD_LABEL || ''),
    },
    clearScreen: false,
  };
});
