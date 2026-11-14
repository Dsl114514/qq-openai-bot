<script setup lang="ts">
/**
 * Usage statistics.
 *
 * NO CHART LIBRARY. Two charts are needed — a bar chart over days and a small list of breakdowns — and a
 * library would add more bytes than the entire console for that. Inline SVG with computed coordinates is
 * about forty lines and has no dependency to keep updated.
 *
 * The bar heights are computed against the window's own maximum rather than a fixed scale, so a quiet week
 * is still legible instead of reading as an empty chart. The absolute numbers are printed with them.
 */
import { ref, computed, onMounted } from 'vue';
import { getStats, type StatsResponse } from '../api';

const data = ref<StatsResponse | null>(null);
const days = ref(30);
const error = ref<string | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  error.value = null;
  try {
    data.value = await getStats(days.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** The tallest bar, used as the scale. Never zero, so an empty window does not divide by zero. */
const peak = computed(() => Math.max(1, ...(data.value?.days ?? []).map((d) => d.total)));

const fmtNum = (n: number): string => n.toLocaleString('en-US');

/** A day label shortened to `MM-DD`, since the year is the same across the window. */
const shortDay = (day: string): string => day.slice(5);

onMounted(load);
</script>

<template>
  <div class="card">
    <h2>用量统计</h2>
    <form class="row" @submit.prevent="load">
      <div>
        <label>统计范围</label>
        <select v-model.number="days">
          <option :value="7">最近 7 天</option>
          <option :value="30">最近 30 天</option>
          <option :value="90">最近 90 天</option>
          <option :value="365">最近 365 天</option>
        </select>
      </div>
      <div><button class="primary" type="submit">刷新</button></div>
      <span v-if="loading" class="hint">加载中…</span>
    </form>
  </div>

  <div v-if="error" class="banner bad">{{ error }}</div>

  <template v-if="data">
    <div class="card">
      <h2>总览</h2>
      <div class="row" style="gap: 28px">
        <div><div class="muted">调用总数</div><div style="font-size: 24px">{{ fmtNum(data.total) }}</div></div>
        <div><div class="muted">延迟 P50</div><div style="font-size: 24px">{{ fmtNum(data.latency.p50) }} ms</div></div>
        <div><div class="muted">延迟 P95</div><div style="font-size: 24px">{{ fmtNum(data.latency.p95) }} ms</div></div>
        <div><div class="muted">最慢</div><div style="font-size: 24px">{{ fmtNum(data.latency.max) }} ms</div></div>
        <div>
          <div class="muted">tokens（输入/输出）</div>
          <div style="font-size: 24px">{{ fmtNum(data.tokens.prompt) }} / {{ fmtNum(data.tokens.completion) }}</div>
        </div>
      </div>
      <p class="hint">
        统计窗口：{{ new Date(data.from).toLocaleString('zh-CN') }} 起。按<strong>本地日</strong>分桶，不是 UTC。
      </p>
    </div>

    <div class="card">
      <h2>每天的调用量</h2>
      <p v-if="data.days.length === 0" class="muted">这个范围内没有记录。</p>
      <svg v-else :viewBox="`0 0 ${Math.max(data.days.length * 22, 200)} 130`" style="width: 100%; height: 150px">
        <!-- Baseline, so a zero-height bar still reads as "zero" rather than "missing". -->
        <line
          :x1="0"
          :y1="110"
          :x2="Math.max(data.days.length * 22, 200)"
          :y2="110"
          stroke="currentColor"
          stroke-opacity="0.2"
        />
        <g v-for="(d, i) in data.days" :key="d.day">
          <rect
            :x="i * 22 + 3"
            :y="110 - (d.total / peak) * 100"
            width="16"
            :height="Math.max((d.total / peak) * 100, d.total > 0 ? 2 : 0)"
            fill="var(--accent)"
            fill-opacity="0.75"
          >
            <title>{{ d.day }}：{{ d.total }} 次{{ d.errors ? `，${d.errors} 次失败` : '' }}</title>
          </rect>
          <!-- Failures stacked in red on top, so a bad day is visible without reading the numbers. -->
          <rect
            v-if="d.errors > 0"
            :x="i * 22 + 3"
            :y="110 - (d.total / peak) * 100"
            width="16"
            :height="Math.max((d.errors / peak) * 100, 2)"
            fill="var(--bad-fg)"
            fill-opacity="0.85"
          >
            <title>{{ d.day }}：{{ d.errors }} 次失败</title>
          </rect>
          <text
            :x="i * 22 + 11"
            :y="124"
            font-size="8"
            text-anchor="middle"
            fill="currentColor"
            fill-opacity="0.55"
          >
            {{ shortDay(d.day) }}
          </text>
        </g>
      </svg>
      <p class="hint">蓝 = 总调用，红 = 其中状态码 ≥ 400 的。鼠标悬停看具体数字。</p>
    </div>

    <div class="row" style="align-items: flex-start">
      <div class="card" style="flex: 1; min-width: 260px">
        <h2>按来源</h2>
        <table>
          <tbody>
            <tr v-for="o in data.byOrigin" :key="o.origin">
              <td>{{ o.origin }}</td>
              <td class="num">{{ fmtNum(o.n) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="data.byOrigin.length === 0" class="muted">无数据</p>
      </div>

      <div class="card" style="flex: 1; min-width: 260px">
        <h2>按状态码</h2>
        <table>
          <tbody>
            <tr v-for="s in data.byStatus" :key="s.status">
              <td><span class="pill" :class="s.status >= 500 ? 'bad' : s.status >= 400 ? 'warn' : 'good'">{{ s.status }}</span></td>
              <td class="num">{{ fmtNum(s.n) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="data.byStatus.length === 0" class="muted">无数据</p>
      </div>

      <div class="card" style="flex: 1; min-width: 260px">
        <h2>最活跃</h2>
        <table>
          <tbody>
            <tr v-for="u in data.topUsers" :key="u.ref">
              <td><code>{{ u.ref.slice(0, 16) }}</code></td>
              <td class="num">{{ fmtNum(u.n) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="data.topUsers.length === 0" class="muted">无数据</p>
      </div>
    </div>
  </template>
</template>
