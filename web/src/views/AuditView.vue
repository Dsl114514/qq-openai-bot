<script setup lang="ts">
/**
 * The audit list.
 *
 * What this view is FOR: answering "which call did X" and "what broke". Bodies are not shown here —
 * a page of 50 rows carrying 50 transcripts would be megabytes — so a row opens the detail view
 * instead. That split is the same one the server-rendered version had, and it is the reason the
 * detail endpoint exists separately.
 *
 * Filtering is server-side. Doing it in the browser would only ever filter the current page, which
 * looks like a filter and is not one.
 */
import { ref, watch, onMounted } from 'vue';
import { listCalls, fmtTime, statusTone, type CallLogRow } from '../api';

const props = defineProps<{ query: URLSearchParams }>();
const emit = defineEmits<{ open: [id: number] }>();

const rows = ref<CallLogRow[]>([]);
const total = ref(0);
const offset = ref(0);
const limit = 50;
const loading = ref(false);
const error = ref<string | null>(null);

const origin = ref(props.query.get('origin') ?? '');
const status = ref(props.query.get('status') ?? '');
const search = ref(props.query.get('search') ?? '');

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const res = await listCalls({
      origin: origin.value || undefined,
      status: status.value || undefined,
      search: search.value || undefined,
      offset: offset.value,
      limit,
    });
    rows.value = res.rows;
    total.value = res.total;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** Reset to the first page whenever the filter changes, or the offset would point past the results. */
function applyFilters() {
  offset.value = 0;
  void load();
}

/**
 * A download URL carrying the active filters.
 *
 * Deliberately not a `fetch`: the server answers with `content-disposition: attachment`, so letting the
 * browser navigate to it produces a normal file download with its own progress and save dialog. Fetching
 * and then synthesising a download would reimplement that, worse.
 */
function exportUrl(format: 'json' | 'csv'): string {
  const q = new URLSearchParams({ format });
  if (origin.value) q.set('origin', origin.value);
  if (status.value) q.set('status', status.value);
  return `/admin/api/export/calls?${q.toString()}`;
}

function go(next: number) {
  offset.value = Math.max(0, next);
  void load();
}

// React to a hash change from the shell (e.g. a back-navigation with different filters).
watch(
  () => props.query.toString(),
  (qs) => {
    const q = new URLSearchParams(qs);
    origin.value = q.get('origin') ?? '';
    status.value = q.get('status') ?? '';
    search.value = q.get('search') ?? '';
    offset.value = 0;
    void load();
  },
);

onMounted(load);
</script>

<template>
  <div class="card">
    <h2>筛选</h2>
    <form class="row" @submit.prevent="applyFilters">
      <div>
        <label>来源</label>
        <select v-model="origin">
          <option value="">全部</option>
          <option value="access_key">access_key</option>
          <option value="qq">qq</option>
          <option value="workbench">workbench</option>
        </select>
      </div>
      <div>
        <label>状态码</label>
        <input v-model="status" size="6" placeholder="200" />
      </div>
      <div style="flex: 1; min-width: 220px">
        <label>正文搜索</label>
        <input v-model="search" style="width: 100%" placeholder="在请求/响应正文里找" />
      </div>
      <div><button class="primary" type="submit">筛选</button></div>
      <div>
        <button
          type="button"
          @click="
            origin = '';
            status = '';
            search = '';
            applyFilters();
          "
        >
          重置
        </button>
      </div>
    </form>
  </div>

  <div class="card">
    <h2>
      调用记录 · 共 {{ total }} 条，显示第 {{ total === 0 ? 0 : offset + 1 }}–{{
        Math.min(offset + limit, total)
      }}
      条
    </h2>

    <div v-if="error" class="banner bad">{{ error }}</div>
    <p v-if="loading" class="muted">加载中…</p>

    <table v-if="rows.length > 0">
      <thead>
        <tr>
          <th class="num">#</th>
          <th>时间</th>
          <th>来源</th>
          <th>引用</th>
          <th>模型</th>
          <th class="num">延迟</th>
          <th class="num">tok</th>
          <th>状态</th>
          <th>错误</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td class="num"><a href="#" @click.prevent="emit('open', r.id)">{{ r.id }}</a></td>
          <td class="muted">{{ fmtTime(r.created_at) }}</td>
          <td>{{ r.origin }}</td>
          <td class="muted">{{ r.origin_ref ?? '' }}</td>
          <td>{{ r.model }}</td>
          <td class="num">{{ r.latency_ms }} ms</td>
          <td class="num">{{ r.prompt_tokens ?? '' }}/{{ r.completion_tokens ?? '' }}</td>
          <td><span class="pill" :class="statusTone(r.status)">{{ r.status }}</span></td>
          <td class="muted">{{ (r.error ?? '').slice(0, 60) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading" class="muted">没有匹配的记录</p>

    <div class="row" style="margin-top: 12px">
      <button v-if="offset > 0" type="button" @click="go(offset - limit)">上一页</button>
      <button v-if="offset + limit < total" type="button" @click="go(offset + limit)">下一页</button>
      <span style="flex: 1"></span>
      <!-- Plain links, not fetch: the response is a download (`content-disposition: attachment`), and
           navigating to it lets the browser handle the file exactly as it would any other download.
           They carry the current filters, so "export" means "export what I am looking at". -->
      <a :href="exportUrl('json')"><button type="button">导出 JSON</button></a>
      <a :href="exportUrl('csv')"><button type="button">导出 CSV</button></a>
    </div>
    <p class="hint">
      导出会带上当前的筛选条件（上限 5 万条）。CSV 里的正文做了正确的引号转义 —— 那是任意文本，含逗号和换行。
    </p>
  </div>
</template>
