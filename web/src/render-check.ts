/**
 * Render-check entry: render every view once, on the server, so a template that references something
 * that does not exist fails LOUDLY here instead of blanking a page in the browser.
 *
 * WHY THIS EXISTS. `QqView.vue` contained `{{ location.origin }}`. Vue templates resolve names against
 * the COMPONENT INSTANCE only — never against globals — so that expression is an undefined property, and
 * reading it THROWS during render. A thrown render blanks the entire view with no visible error, which
 * presented as "clicking QQ 接入 shows nothing".
 *
 * A regex over template text can only find names someone thought to list. Actually RUNNING the render
 * function finds every undefined reference, including typos and renamed variables, because the failure is
 * a real exception rather than a pattern match.
 *
 * Built with `vite build --ssr` and executed by scripts/check-views-render.mjs.
 */
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

import App from './App.vue';
import AuditView from './views/AuditView.vue';
import CallView from './views/CallView.vue';
import HistoryView from './views/HistoryView.vue';
import SessionsView from './views/SessionsView.vue';
import WorkbenchView from './views/WorkbenchView.vue';
import QqView from './views/QqView.vue';
import StatusView from './views/StatusView.vue';
import SettingsView from './views/SettingsView.vue';
import StatsView from './views/StatsView.vue';
import TasksView from './views/TasksView.vue';

/**
 * Browser globals the app legitimately uses in setup code.
 *
 * THESE MUST BE STUBBED, and the distinction matters: `location.origin` inside `setup()` works in a
 * browser and is only undefined under Node, whereas an undefined name in a TEMPLATE is a real bug. Without
 * stubs both throw here, so the check cannot tell them apart and reports false failures.
 *
 * With the globals present, a template reference still throws — Vue resolves template names against the
 * component instance, never against `globalThis`, so stubbing `location` does not rescue `{{ location }}`.
 * That is precisely why stubbing is safe: it removes the false positives and leaves the real ones.
 */
function installBrowserGlobals(): void {
  const g = globalThis as Record<string, unknown>;

  g.location ??= {
    origin: 'https://qq.hacknet.de5.net',
    href: 'https://qq.hacknet.de5.net/admin',
    hash: '',
    pathname: '/admin',
    search: '',
  };
  g.window ??= globalThis;
  g.navigator ??= { userAgent: 'render-check', language: 'zh-CN' };
  g.document ??= {
    getElementById: () => null,
    body: {},
    createElement: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.localStorage ??= {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  // `onMounted` never runs during SSR, so a fetch stub is only a safety net.
  g.fetch ??= async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

installBrowserGlobals();

/** Props each view needs to render at all. Deliberately populated, not empty. */
const status = {
  ed25519: { preferred: 'Ed25519', detail: ['ok'] },
  qq: {
    sandbox: false,
    apiHost: 'https://api.sgroup.qq.com',
    appId: '1905603747',
    identity: { status: 200, body: { username: '测试机器人', robot_uin: '4013367121' } },
    shareUrl: 'https://example.invalid/share',
    error: null,
  },
  timeZone: 'Asia/Shanghai',
  groups: [{ openid: 'AC4FBFFF8A2C43F360F6A5B3D06DCB81', label: '测试群 · AC4FBFFF…' }],
  interjections: [
    {
      group: 'AC4FBFFF8A2C43F360F6A5B3D06DCB81',
      config: { enabled: true, perDay: 2, mode: 'fixed', at: '21:30', text: '冒泡' },
      sent: 1,
      nextDueAt: Date.now() + 3_600_000,
      ambient: 0,
    },
  ],
};

const views = [
  ['AuditView', AuditView, { query: new URLSearchParams('origin=qq&status=200'), onOpen: () => {} }],
  ['CallView', CallView, { id: 1, onBack: () => {} }],
  ['HistoryView', HistoryView, { onOpen: () => {} }],
  ['SessionsView', SessionsView, { onChanged: () => {} }],
  ['TasksView', TasksView, {}],
  ['WorkbenchView', WorkbenchView, {}],
  ['QqView', QqView, { status, onChanged: () => {} }],
  ['SettingsView', SettingsView, { onChanged: () => {} }],
  ['StatsView', StatsView, {}],
  ['StatusView', StatusView, { status, onChanged: () => {} }],
];

export async function renderAll() {
  const results = [];

  // Vue's warnings are noise here: the check reports its own pass/fail per view, and a warning printed for
  // one view reads as if it belonged to the next. Silent them so a real failure stands out.
  const realWarn = console.warn;
  const realError = console.error;
  console.warn = () => {};
  console.error = () => {};

  try {
    // The App shell too: it is the one that mounts first, so a failure there blanks everything.
    for (const [name, component, props] of [['App', App, {}], ...views]) {
      try {
        const app = createSSRApp({ render: () => h(component, props) });
        const html = await renderToString(app);
        results.push({ name, ok: true, html, length: html.length });
      } catch (e) {
        results.push({ name, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }

  return results;
}
