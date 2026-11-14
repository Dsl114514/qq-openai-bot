<script setup lang="ts">
/**
 * The workbench: chat with the model from the browser.
 *
 * A completion is ONE authenticated POST to the configured endpoint — there is no proof-of-work challenge to
 * solve here, because there is no DeepSeek web protocol to satisfy. The endpoint, its key and its model are
 * whatever the 设置 → 模型来源 page has configured.
 *
 * The conversation lives on the SERVER (via `session_key`), so a page reload resumes it instead of starting
 * over — which is why nothing about the history is kept in this component.
 */
import { ref, onMounted, nextTick, computed } from 'vue';
import { api, fmtDuration, type StatusResponse } from '../api';

interface Msg {
  kind: 'user' | 'bot' | 'err';
  text: string;
}

/**
 * What the SERVER thinks the workbench conversation is.
 *
 * Shown because the browser deliberately holds nothing about the history — it lives in D1 and is addressed
 * by `session_key`. Without this, "does it still remember?" can only be answered by observing that the bot
 * recalls something, which is indistinguishable from a coincidence.
 */
interface ServerSession {
  sessionKey: string;
  sessionId: string | null;
  lastMessageId: string | null;
  day: string | null;
  today: string;
  timeZone: string;
  /** Whether the stored history would actually be CONTINUED — not merely whether one exists. */
  current: boolean;
  /** The same answer in words, so the rule does not have to be known to read the panel. */
  reason: string;
}

const messages = ref<Msg[]>([]);
const input = ref('');
const hint = ref('');
const busy = ref(false);
const thinking = ref(false);
const search = ref(false);
const chatEl = ref<HTMLElement | null>(null);
const status = ref<StatusResponse | null>(null);
const serverSession = ref<ServerSession | null>(null);

/** Refresh what the server believes about this conversation. */
async function loadServerSession() {
  try {
    serverSession.value = await api.get<ServerSession>('/admin/workbench/session');
  } catch {
    // The status banner already reports a systemic failure; a missing history record is not worth a second
    // error message, and the panel simply stays blank.
    serverSession.value = null;
  }
}

async function scrollDown() {
  await nextTick();
  chatEl.value?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function send() {
  const text = input.value.trim();
  if (!text || busy.value) return;
  input.value = '';
  messages.value.push({ kind: 'user', text });
  const bot: Msg = { kind: 'bot', text: '' };
  messages.value.push(bot);
  busy.value = true;
  await scrollDown();

  try {
    hint.value = '请求模型…';
    // One POST. The conversation is managed server-side via `session_key`, so the browser sends only the new
    // message and the server prepends the stored history itself.
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        session_key: 'workbench',
        messages: [{ role: 'user', content: text }],
        thinking: thinking.value,
        search: search.value,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const t = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        msg = JSON.parse(t).error?.message ?? msg;
      } catch {
        /* keep the status-based message */
      }
      throw new Error(msg);
    }

    // Read the SSE stream directly so tokens appear as they arrive.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          if (chunk.error) throw new Error(chunk.error.message);
          const piece = chunk.choices?.[0]?.delta?.content;
          if (piece) {
            bot.text += piece;
            await scrollDown();
          }
        }
      }
    }
    if (!bot.text) bot.text = '（空响应）';
    hint.value = '完成 · 记录已写入审计台';
  } catch (e) {
    bot.kind = 'err';
    bot.text = e instanceof Error ? e.message : String(e);
    hint.value = '';
  } finally {
    busy.value = false;
    await scrollDown();
    // Refreshed after the turn, because the server's record changed as a result of it — this is where the
    // panel earns its place: the growing message count is the evidence that the conversation advanced.
    void loadServerSession();
  }
}

async function newSession() {
  if (!confirm('更换会话：当前上下文会被丢弃，下一条消息从空白开始。继续？')) return;
  try {
    await api.post('/admin/workbench/reset');
    messages.value = [];
    hint.value = '已更换会话 —— 下一条消息会开一个新会话';
    await loadServerSession();
  } catch (e) {
    hint.value = '更换失败：' + (e instanceof Error ? e.message : String(e));
  }
}

/** A mode directive is also accepted as text, so the two paths can be compared. */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
}

const modeLabel = computed(() => {
  const on: string[] = [];
  if (thinking.value) on.push('深度思考');
  if (search.value) on.push('联网搜索');
  return on.length ? on.join(' · ') : '普通模式';
});

onMounted(async () => {
  try {
    status.value = await api.get<StatusResponse>('/admin/api/status');
  } catch {
    /* the banner in the shell already reports a status failure */
  }
  await loadServerSession();
});
</script>

<template>
  <div class="card">
    <h2>工作台</h2>
    <p class="muted">
      直接对话当前配置的模型 —— 端点、Key 和模型名在「设置 → 模型来源」里配置。
      会话由服务端管理，<b>刷新页面不会丢</b>。
    </p>
    <div class="row">
      <div>
        <label>深度思考</label>
        <input v-model="thinking" type="checkbox" />
      </div>
      <div>
        <label>联网搜索</label>
        <input v-model="search" type="checkbox" />
      </div>
      <div><button type="button" @click="newSession">更换会话</button></div>
      <div><button type="button" @click="messages = []">清空显示</button></div>
      <div class="muted" style="font-size: 12px">当前：{{ modeLabel }}</div>
    </div>
  </div>

  <!-- What the SERVER holds. The browser keeps no conversation state, so this is the only way to confirm a
       thread exists and is being continued. -->
  <div class="card" v-if="serverSession">
    <h2>服务端会话</h2>
    <table>
      <tbody>
        <tr>
          <th>状态</th>
          <td>
            <span class="pill" :class="serverSession.current ? 'good' : 'warn'">
              {{ serverSession.current ? '会延续' : '下条消息开新会话' }}
            </span>
            <span class="muted"> · {{ serverSession.reason }}</span>
          </td>
        </tr>
        <tr>
          <th>已存消息</th>
          <td><code>{{ serverSession.lastMessageId ? `${serverSession.lastMessageId} 条` : '（还没有对话）' }}</code></td>
        </tr>
        <tr>
          <th>日期</th>
          <td>
            {{ serverSession.day ?? '—' }}
            <span class="muted">（今天 {{ serverSession.today }}，{{ serverSession.timeZone }}）</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="hint">
      对话历史存在服务端 —— 每次请求都会把历史一起发给模型，这是无状态接口延续上下文的唯一方式。
    </p>
  </div>

  <div class="chat" ref="chatEl">
    <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.kind">{{ m.text }}</div>
  </div>

  <div class="card">
    <textarea
      v-model="input"
      rows="3"
      style="width: 100%"
      placeholder="输入消息，Ctrl+Enter 发送"
      @keydown="onKey"
    ></textarea>
    <div class="row" style="margin-top: 8px">
      <button class="primary" :disabled="busy" @click="send">发送</button>
      <span class="hint">{{ hint }}</span>
    </div>
    <p class="hint">
      「更换会话」丢弃上下文；「清空显示」只是清屏，<b>不影响会话</b>。
    </p>
  </div>
</template>
