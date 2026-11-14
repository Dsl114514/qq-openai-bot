<script setup lang="ts">
/**
 * One call, with both bodies.
 *
 * The bodies are stored as JSON TEXT (that is what D1 holds), so they are pretty-printed here for
 * reading rather than shown as one long line. Pretty-printing can fail on a body that is not JSON —
 * a truncated stream, for instance — and when it does the raw text is shown instead of an error,
 * because the raw text is the diagnostic.
 */
import { ref, onMounted } from 'vue';
import { getCall, fmtTime, statusTone, type CallLogDetail } from '../api';

const props = defineProps<{ id: number }>();
const emit = defineEmits<{ back: [] }>();

const row = ref<CallLogDetail | null>(null);
const error = ref<string | null>(null);

function pretty(text: string | null): string {
  if (!text) return '(空)';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

onMounted(async () => {
  try {
    row.value = await getCall(props.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <p><button type="button" @click="emit('back')">← 回到列表</button></p>

  <div v-if="error" class="banner bad">{{ error }}</div>

  <template v-if="row">
    <div class="card">
      <h2>调用 #{{ row.id }}</h2>
      <table>
        <tbody>
          <tr>
            <th>时间</th>
            <td>{{ fmtTime(row.created_at) }}</td>
            <th>来源</th>
            <td>{{ row.origin }} {{ row.origin_ref ?? '' }}</td>
          </tr>
          <tr>
            <th>模型</th>
            <td>{{ row.model }}</td>
            <th>延迟</th>
            <td>{{ row.latency_ms }} ms</td>
          </tr>
          <tr>
            <th>状态</th>
            <td><span class="pill" :class="statusTone(row.status)">{{ row.status }}</span></td>
            <th>tokens</th>
            <td>{{ row.prompt_tokens ?? '-' }} / {{ row.completion_tokens ?? '-' }}</td>
          </tr>
          <tr>
            <th>错误</th>
            <td colspan="3">{{ row.error ?? '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>请求体</h2>
      <pre>{{ pretty(row.request_body) }}</pre>
    </div>

    <div class="card">
      <h2>响应体</h2>
      <pre>{{ pretty(row.response_body) }}</pre>
    </div>
  </template>
</template>
