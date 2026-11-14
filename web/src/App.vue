<script setup lang="ts">
/**
 * App shell.
 *
 * THIS IS AN SFC RATHER THAN A `template` STRING, AND THAT IS LOAD-BEARING. Vite resolves `vue` to the
 * RUNTIME-ONLY build (`vue.runtime.esm-bundler.js`), which has no template compiler — so a component that
 * passes a `template` string mounts fine and renders NOTHING, producing a blank page with no error in the
 * console. An SFC is compiled at build time, so it does not need the runtime compiler.
 *
 * That failure is invisible to every server-side check: the shell, the bundle and the CSS all return 200,
 * and the bundle is a valid module. It only shows up when a browser runs it — or when someone notices the
 * template sitting in the bundle as an unused string literal.
 *
 * Routing is a tiny hash router rather than vue-router: six views, no nesting, no guards, and no route
 * params beyond a query string. It also needs no server-side rewrite, which matters because the Worker
 * owns these paths and a deep link must not require a special rule.
 */
import { ref, computed, onMounted, onUnmounted, onErrorCaptured } from 'vue';
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
import { getStatus, type StatusResponse } from './api';

const route = ref(parseHash());

function parseHash(): { name: string; query: URLSearchParams } {
  // `#/audit?origin=qq` — the leading `#/` is the conventional hash-route form.
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { name: path || 'audit', query: new URLSearchParams(qs ?? '') };
}

const onHashChange = () => {
  route.value = parseHash();
};

// Shared status, fetched once and passed down: the QQ and Status views both need it, and fetching it
// twice would mean two round trips and two chances to disagree.
const status = ref<StatusResponse | null>(null);
const statusError = ref<string | null>(null);
let timer: number | undefined;

async function loadStatus() {
  try {
    status.value = await getStatus();
    statusError.value = null;
  } catch (e) {
    statusError.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange);
  void loadStatus();
  // A slow poll keeps the token countdown and the interjection countdown honest. Ten seconds is
  // frequent enough to feel live and rare enough to be invisible in the request budget.
  timer = window.setInterval(loadStatus, 10_000);
});

onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
  if (timer) window.clearInterval(timer);
});

function navigate(name: string, query?: Record<string, string>) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  location.hash = `#/${name}${qs}`;
}

const nav = [
  { name: 'audit', label: '审计台' },
  { name: 'history', label: '对话历史' },
  { name: 'stats', label: '统计' },
  { name: 'sessions', label: '会话' },
  { name: 'tasks', label: '定时任务' },
  { name: 'workbench', label: '工作台' },
  { name: 'qq', label: 'QQ 接入' },
  { name: 'settings', label: '设置' },
  { name: 'status', label: '状态' },
];

/** Which nav entry is active, treating `call` as part of the audit view. */
const active = computed(() => (route.value.name === 'call' ? 'audit' : route.value.name));

/**
 * Catch a view that throws while rendering, and show WHY instead of a blank page.
 *
 * WHY THIS IS HERE. A render error in one view used to unmount the whole tree: the nav disappeared, the
 * page went white, and the only evidence was in the browser console — which is not where anyone looks when
 * "the page does not display". The trace from that failure (`QqView.vue:126` reading `origin` of undefined)
 * was the actual diagnosis, and it was invisible in the UI.
 *
 * `onErrorCaptured` keeps the shell alive and puts the error on screen, so the same failure is now
 * self-describing. Returning `false` stops it from propagating and blanking the app.
 *
 * The component is also re-keyed by the error counter so navigating away and back retries the mount —
 * otherwise a view that threw once stays broken for the rest of the session.
 */
const crash = ref<{ message: string; stack: string } | null>(null);

onErrorCaptured((err) => {
  crash.value = {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? (err.stack ?? '') : '',
  };
  return false;
});

/** Retry the failed view by remounting it. */
function retry() {
  crash.value = null;
  route.value = { ...route.value };
}
</script>

<template>
  <header class="app-header">
    <h1>cf-ds-api-qq-bot</h1>
    <nav class="app-nav">
      <button
        v-for="item in nav"
        :key="item.name"
        :class="{ active: active === item.name }"
        @click="navigate(item.name)"
      >
        {{ item.label }}
      </button>
    </nav>
    <span v-if="status" class="muted" style="margin-left: auto; font-size: 12px">
      {{ status.qq.sandbox ? '沙箱' : '正式' }}
    </span>
  </header>

  <main class="app-main">
    <div v-if="statusError" class="banner bad">状态获取失败：{{ statusError }}</div>

    <!-- A view that threw while rendering. Shown in place of the view so the failure is legible instead
         of a blank page, and so the nav stays usable for switching to a working one. -->
    <div v-if="crash" class="banner bad">
      <p><strong>这个页面渲染失败</strong> —— 其余功能不受影响，可以从上面切换到别的页面。</p>
      <p><code>{{ crash.message }}</code></p>
      <details>
        <summary>调用栈</summary>
        <pre>{{ crash.stack }}</pre>
      </details>
      <button type="button" @click="retry">重试</button>
    </div>

    <template v-else>
      <AuditView
        v-if="route.name === 'audit'"
        :key="route.query.toString()"
        :query="route.query"
        @open="(id: number) => navigate('call', { id: String(id) })"
      />
      <CallView
        v-else-if="route.name === 'call'"
        :key="route.query.get('id') ?? ''"
        :id="Number(route.query.get('id'))"
        @back="navigate('audit')"
      />
      <HistoryView
        v-else-if="route.name === 'history'"
        @open="(id: number) => navigate('call', { id: String(id) })"
      />
      <StatsView v-else-if="route.name === 'stats'" />
      <SessionsView v-else-if="route.name === 'sessions'" @changed="loadStatus" />
      <TasksView v-else-if="route.name === 'tasks'" />
      <WorkbenchView v-else-if="route.name === 'workbench'" />
      <QqView v-else-if="route.name === 'qq'" :status="status" @changed="loadStatus" />
      <SettingsView v-else-if="route.name === 'settings'" @changed="loadStatus" />
      <StatusView v-else-if="route.name === 'status'" :status="status" @changed="loadStatus" />
      <div v-else class="card">未知页面：{{ route.name }}</div>
    </template>
  </main>
</template>
