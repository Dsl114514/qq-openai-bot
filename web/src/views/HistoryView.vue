<script setup lang="ts">
/**
 * Conversations read as conversations.
 *
 * This view existed in the server-rendered console and was lost in the Vue rewrite — it is being restored,
 * not invented. The distinction it makes is still the point:
 *
 *   AUDIT (the other view) is per CALL: one row, raw JSON bodies, which answers "what exactly was sent".
 *   HISTORY (this view) is per CONVERSATION: turns in order, extracted, which answers "what has this group
 *   been talking about".
 *
 * The extraction happens SERVER-side (see apiHistory in src/admin/api.ts) because a page of turns would
 * otherwise ship megabytes of raw bodies for the browser to sift — and the same parsing would then have to
 * exist twice. The raw bodies stay one click away, so this view is a lens and not a replacement.
 */
import { ref, onMounted } from 'vue';
import { getHistory, fmtTime, statusTone, type HistoryResponse, type HistoryTurn } from '../api';

const emit = defineEmits<{ open: [id: number] }>();

const data = ref<HistoryResponse | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const scope = ref('');
const limit = ref(50);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await getHistory(scope.value, limit.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** The kind badge, so a scheduled send is not mistaken for a reply to something. */
function kindLabel(kind: HistoryTurn['kind']): string | null {
  if (kind === 'task') return '定时任务';
  if (kind === 'interjection') return '主动发言';
  if (kind === 'command') return '指令';
  return null;
}

function scopeLabel(id: string): string {
  // Openids in one group often share a long prefix, so both ends are kept to stay distinguishable.
  return id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

onMounted(load);
</script>

<template>
  <div class="card">
    <h2>对话历史</h2>
    <p class="muted">
      把每次调用的请求与响应正文<strong>提取成可读的对话</strong>。审计台是按「一次调用」看原始 JSON，这一页是按「一段对话」看内容。
    </p>
    <form class="row" @submit.prevent="load">
      <div style="min-width: 320px">
        <label>范围</label>
        <select v-model="scope" style="width: 100%">
          <option value="">全部（最近 {{ limit }} 条）</option>
          <option v-for="s in data?.scopes ?? []" :key="s.id" :value="s.id">
            {{ scopeLabel(s.id) }} · {{ s.n }} 条
          </option>
        </select>
      </div>
      <div>
        <label>条数</label>
        <input v-model.number="limit" type="number" min="1" max="200" size="5" />
      </div>
      <div><button class="primary" type="submit">查看</button></div>
    </form>
  </div>

  <div v-if="error" class="banner bad">{{ error }}</div>

  <div class="card">
    <h2>{{ scope ? `与 ${scopeLabel(scope)} 的对话` : '最近的对话' }} · {{ data?.turns.length ?? 0 }} 轮</h2>

    <p v-if="loading" class="muted">加载中…</p>
    <p v-else-if="!data || data.turns.length === 0" class="muted">没有记录。</p>

    <div
      v-for="t in data?.turns ?? []"
      :key="t.id"
      style="border-left: 3px solid var(--line); padding-left: 12px; margin: 14px 0"
    >
      <div class="muted" style="font-size: 12px">
        #{{ t.id }} · {{ fmtTime(t.createdAt) }} ·
        <span class="pill" :class="statusTone(t.status)">{{ t.status }}</span>
        {{ t.latencyMs }}ms
        <span v-if="kindLabel(t.kind)" class="pill note">{{ kindLabel(t.kind) }}</span>
        <span v-if="t.stage && t.stage !== 'stored-thread'" class="pill note">{{ t.stage }}</span>
      </div>

      <div style="margin-top: 6px">
        <strong>{{ t.kind === 'task' ? '定时' : '用户' }}</strong>：{{ t.user.slice(0, 600) }}
      </div>

      <div v-if="t.reply" style="margin-top: 4px; white-space: pre-wrap">
        <strong>机器人</strong>：{{ t.reply.slice(0, 1200) }}
      </div>
      <div v-else class="muted" style="margin-top: 4px">
        <strong>机器人</strong>：（没有回复）{{ t.error ? ` · ${t.error}` : '' }}
      </div>

      <div class="muted" style="font-size: 12px; margin-top: 4px">
        <a href="#" @click.prevent="emit('open', t.id)">查看原始请求/响应</a>
      </div>
    </div>
  </div>
</template>
