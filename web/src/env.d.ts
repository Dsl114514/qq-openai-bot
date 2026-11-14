/// <reference types="vite/client" />

// SFC support for TypeScript: without this, importing a `.vue` file is a type error even though Vite
// resolves it at build time.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
