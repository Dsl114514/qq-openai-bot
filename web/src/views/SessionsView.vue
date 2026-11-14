<script setup lang="ts">
/**
 * Conversations: who has a thread, whether it is live, and the two actions on it.
 *
 * THE ACTIONS ARE NOT SYMMETRIC and the labels say so:
 *   - 保留 (keep) pins the thread so the daily reset stops applying to it;
 *   - 更换会话 (new session) discards the context entirely.
 *
 * They are easy to confuse — both "do something to the session" — so each carries a hint naming the
 * consequence rather than the mechanism.
 */
import { ref, onMounted } from 'vue';
import { api, listSessions, fmtTime, type SessionsResponse } from '../api';

const emit = defineEmits<{ changed: [] }>();

const data = ref<SessionsResponse | null>(null);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const busy = ref<string | null>(null);

async function load() {
  try {
    data.value = await listSessions();
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function togglePin(id: string, pinned: boolean) {
  busy.value = id;
  try {
    await api.postForm('/admin/qq/pin-session', { id, pinned: String(pinned) });
    note.value = pinned ? `已保留 ${id}` : `已取消保留 ${id}`;
    await load();
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

async function reset(id: string) {
  if (!confirm(`更换会话：${id}\n当前上下文会被丢弃，下一条消息从空白开始。继续？`)) return;
  busy.value = id;
  try {
    await api.postForm('/admin/qq/reset-session', { id, back: '/admin/qq' });
    note.value = `已为 ${id} 开新会话`;
    await load();
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

async function purgeLegacy() {
  busy.value = 'legacy';
  try {
    await api.post('/admin/qq/purge-legacy');
    note.value = '已清理旧格式会话';
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

/** How long since the thread was last used, so staleness is visible without reading dates. */
function since(ms: number): string {
  if (!ms) return '—';
  const d = Date.now() - ms;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

onMounted(load);
</script>

<template>
  <div v-if="error" class="banner bad">{{ error }}</div>
  <div v-if="note" class="banner good">{{ note }}</div>

  <div class="card">
    <h2>会话</h2>
    <p class="muted">
      每人每天一个会话，<b>按渠道分开</b>（单聊和群聊是两条独立线程）。跨天自动重置 —— 但被<b>保留</b>的会话不会。
    </p>
    <table v-if="data">
      <tbody>
        <tr>
          <th>今天</th>
          <td>{{ data.day }} <span class="muted">（{{ data.timeZone }}）</span></td>
        </tr>
        <tr>
          <th>用户</th>
          <td>共 {{ data.stats.users }} 个，其中今天活跃 <strong>{{ data.stats.today }}</strong> 个</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>会话列表</h2>

    <p v-if="data && data.rows.length === 0" class="muted">还没有任何会话。</p>

    <table v-if="data && data.rows.length > 0">
      <thead>
        <tr>
          <th>渠道</th>
          <th>用户 / 标识</th>
          <th>状态</th>
          <th>会话</th>
          <th class="num">上一条</th>
          <th>最后活动</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in data.rows" :key="s.id">
          <td>
            <span class="pill note">{{ s.channel }}</span>
            <span v-if="s.pinned" class="pill good">已保留</span>
          </td>
          <td><code>{{ s.id }}</code></td>
          <td>
            <span v-if="s.pinned" class="pill good">永久保留</span>
            <span v-else-if="s.current" class="pill good">今天</span>
            <span v-else class="pill warn">已过期</span>
          </td>
          <td class="muted">{{ s.sessionId ? s.sessionId.slice(0, 8) + '…' : '（记录损坏）' }}</td>
          <td class="num">{{ s.lastMessageId ?? '—' }}</td>
          <td class="muted">{{ since(s.updatedAt) }}</td>
          <td style="white-space: nowrap">
            <button
              type="button"
              :disabled="busy === s.id"
              @click="togglePin(s.id, !s.pinned)"
            >{{ s.pinned ? '取消保留' : '保留' }}</button>
            <button type="button" :disabled="busy === s.id" @click="reset(s.id)">更换会话</button>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="hint">
      <b>保留</b>：这个会话不再每日重置，适合长期项目。<b>更换会话</b>：丢弃上下文，从空白开始。
    </p>

    <div v-if="data && data.rows.some((s) => s.channel === 'legacy')" style="margin-top: 12px">
      <p class="hint">
        <span class="pill bad">legacy</span> 是渠道隔离修复之前存下的记录，可能混着两种对话，因此不会被继续使用。
      </p>
      <button type="button" :disabled="busy === 'legacy'" @click="purgeLegacy">清理旧格式会话</button>
    </div>
  </div>
</template>
