/**
 * Console entry point.
 *
 * The root component lives in `App.vue` rather than in this file as an object with a `template` string.
 * That is not a style choice: Vite resolves `vue` to the RUNTIME-ONLY build
 * (`vue.runtime.esm-bundler.js`), which has no template compiler. A root component defined here with a
 * `template` string mounts successfully and renders NOTHING — a blank page, no console error, and every
 * server-side check still passing (shell 200, bundle 200, valid module). It was diagnosed by finding the
 * template sitting in the built bundle as an unused string literal.
 *
 * So: every component in this app is an SFC, compiled at build time. Do not add a `template:` option to
 * a `defineComponent({...})` here.
 */

import { createApp } from 'vue';
import './styles.css';
import App from './App.vue';

const root = document.getElementById('app');
if (!root) {
  // A missing mount point means the shell and this bundle disagree — say so rather than mounting into
  // nothing and leaving a blank page with no explanation.
  document.body.textContent = '控制台挂载点 #app 不存在，index.html 与构建产物不匹配。请重新运行 npm run build:web。';
} else {
  createApp(App).mount(root);
}
