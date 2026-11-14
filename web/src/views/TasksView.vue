<script setup lang="ts">
/**
 * Scheduled tasks: the generalised successor to 「发牢骚」.
 *
 * THE FORM HAS TWO TRAPS THE DESIGN WORKS AROUND:
 *
 *   1. A task sends to a group the bot may never have heard from — which can never fire and fails silently.
 *      So the group is a DROPDOWN of groups discovered from real events, and the server refuses an unknown
 *      id anyway (see ADR-0015). There is no free-text field to get wrong.
 *
 *   2. Empty text means "let the model read the group", which is different from "send nothing". Sending an
 *      empty message would be rejected and look like the task was broken, so the field says so.
 *
 * Times are entered as free text and validated on the server, which reports the reason. Validating only in
 * the browser would mean a typo that the client accepts becomes a task that never fires.
 */
import { ref, computed, onMounted } from 'vue';
import { api, getTasks, deleteTask, runTask, saveTask, migrateTasks, type TasksResponse, type ScheduledTask } from '../api';

const data = ref<TasksResponse | null>(null);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const busy = ref<string | null>(null);

/** The form. `timesText` is a comma-separated string because that is how people write times. */
const form = ref({
  id: '',
  name: '',
  group: '',
  kind: 'daily' as 'daily' | 'weekly' | 'interval',
  timesText: '09:00',
  weekdays: [] as number[],
  everyMinutes: 120,
  text: '',
  enabled: true,
  cron: '',
});

const knownGroups = computed(() => data.value?.knownGroups ?? []);
const tasks = computed(() => data.value?.tasks ?? []);

const WEEKDAYS = [
  { n: 1, label: '一' },
  { n: 2, label: '二' },
  { n: 3, label: '三' },
  { n: 4, label: '四' },
  { n: 5, label: '五' },
  { n: 6, label: '六' },
  { n: 7, label: '日' },
];

async function load() {
  try {
    data.value = await getTasks();
    if (!form.value.group && knownGroups.value.length > 0) form.value.group = knownGroups.value[0].openid;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function save() {
  busy.value = 'save';
  note.value = null;
  error.value = null;
  try {
    const r = await saveTask({
      group: form.value.group,
      name: form.value.name || '未命名任务',
      kind: form.value.kind,
      enabled: String(form.value.enabled),
      // A cron string, when given, takes precedence and is expanded server-side.
      ...(form.value.cron.trim()
        ? { cron: form.value.cron.trim() }
        : {
            times: form.value.timesText
              .split(/[,，\s]+/)
              .map((t) => t.trim())
              .filter(Boolean),
          }),
      ...(form.value.kind === 'weekly' ? { weekdays: form.value.weekdays.map(String) } : {}),
      ...(form.value.kind === 'interval' ? { everyMinutes: String(form.value.everyMinutes) } : {}),
      ...(form.value.text.trim() ? { text: form.value.text } : {}),
    });
    note.value = r.detail;
    if (r.ok) resetForm();
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

function resetForm() {
  form.value = {
    id: '',
    name: '',
    group: knownGroups.value[0]?.openid ?? '',
    kind: 'daily',
    timesText: '09:00',
    weekdays: [],
    everyMinutes: 120,
    text: '',
    enabled: true,
    cron: '',
  };
}

/** Load an existing task into the form for editing. */
function edit(t: ScheduledTask) {
  form.value = {
    id: t.id,
    name: t.name,
    group: t.group,
    kind: t.kind,
    timesText: t.times.join(', '),
    weekdays: [...t.weekdays],
    everyMinutes: t.everyMinutes,
    text: t.content.kind === 'fixed' ? t.content.text : '',
    enabled: t.enabled,
    cron: '',
  };
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function remove(t: ScheduledTask) {
  if (!confirm(`删除任务「${t.name}」？`)) return;
  busy.value = t.id;
  try {
    const r = await deleteTask(t.id);
    note.value = r.detail;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

async function runNow(t: ScheduledTask) {
  busy.value = t.id;
  note.value = null;
  error.value = null;
  try {
    const r = await runTask(t.id);
    // A failed manual run is shown as an error rather than a note: it is the one time the reason matters,
    // and the server's message usually names the cause (no group messages, empty reply, send refused).
    if (r.ok) note.value = r.detail;
    else error.value = r.detail;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

async function migrate() {
  busy.value = 'migrate';
  note.value = null;
  try {
    const r = await migrateTasks();
    note.value = r.detail;
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
  }
}

function describe(t: ScheduledTask): string {
  if (t.kind === 'interval') return `每 ${t.everyMinutes} 分钟`;
  const days = t.kind === 'weekly' ? `每周 ${t.weekdays.map((d) => WEEKDAYS.find((w) => w.n === d)?.label ?? d).join('、')} ` : '每天 ';
  return `${days}${t.times.join('、')}`;
}

/** How long since the task last ran, so a silent failure is visible at a glance. */
function lastRun(ms?: number): string {
  if (!ms) return '从未运行';
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
    <h2>定时任务</h2>
    <p class="muted">
      机器人<strong>自己找时机</strong>在群里发消息，不需要有人 @ 它。所有任务共用「事件触发」的调度方式:
      没有定时器，而是在<strong>任何消息到达时</strong>检查有没有到点的任务。
    </p>
    <p class="hint">
      这意味着：<strong>群里完全没人说话时，任务不会准时触发</strong>，会在下一条消息到达时补上。
      免费版 Worker 没有独立时钟，这是唯一可行的做法。
    </p>
  </div>

  <div class="card">
    <h2>{{ form.id ? '编辑任务' : '新建任务' }}</h2>

    <p v-if="knownGroups.length === 0" class="banner bad">
      还没有已知的群 —— 先在群里 @ 一次机器人。定时发送需要一个真实存在的群，否则会静默失败。
    </p>

    <form v-else @submit.prevent="save">
      <div class="row">
        <div style="min-width: 300px">
          <label>群</label>
          <select v-model="form.group" style="width: 100%">
            <option v-for="g in knownGroups" :key="g.openid" :value="g.openid">{{ g.label }}</option>
          </select>
        </div>
        <div>
          <label>任务名（同名即覆盖）</label>
          <input v-model="form.name" placeholder="早报提醒" size="18" />
        </div>
        <div>
          <label>类型</label>
          <select v-model="form.kind">
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="interval">按间隔</option>
          </select>
        </div>
      </div>

      <div class="row" style="margin-top: 10px; align-items: flex-start">
        <template v-if="form.kind !== 'interval'">
          <div style="min-width: 240px">
            <label>时间（HH:MM，逗号分隔多个）</label>
            <input v-model="form.timesText" style="width: 100%" placeholder="09:00, 21:30" />
          </div>
          <div v-if="form.kind === 'weekly'" style="min-width: 280px">
            <label>星期</label>
            <div class="row" style="gap: 4px">
              <label v-for="w in WEEKDAYS" :key="w.n" style="margin: 0">
                <input v-model="form.weekdays" type="checkbox" :value="w.n" /> {{ w.label }}
              </label>
            </div>
          </div>
        </template>
        <div v-else>
          <label>间隔（分钟，最少 30）</label>
          <input v-model.number="form.everyMinutes" type="number" min="30" size="7" />
        </div>
      </div>

      <div class="row" style="margin-top: 10px">
        <div>
          <label>或直接填 cron（会展开成上面的时间）</label>
          <input v-model="form.cron" placeholder="30 21 * * *" size="16" />
        </div>
        <span class="hint">只支持「分 时 * * *」和「分 时 * * 星期」，例如 <code>0 9 * * 1,5</code>。</span>
      </div>

      <div style="margin-top: 10px">
        <label>固定内容（留空 = 让模型读群聊接一句）</label>
        <textarea v-model="form.text" rows="2" style="width: 100%" placeholder="留空 = 模型根据群友最近的发言生成；填了就原样发送。"></textarea>
        <p class="hint">
          <strong>留空不是「发空消息」</strong> —— 那会让模型读群聊接一句话。发空消息 QQ 会拒绝，看起来像任务坏了。
        </p>
      </div>

      <div class="row" style="margin-top: 10px">
        <div>
          <label>启用</label>
          <input v-model="form.enabled" type="checkbox" />
        </div>
        <div><button class="primary" type="submit" :disabled="busy === 'save'">保存</button></div>
        <div v-if="form.id"><button type="button" @click="resetForm">取消编辑</button></div>
      </div>
    </form>
  </div>

  <div class="card">
    <h2>任务列表 · {{ tasks.length }} 个</h2>

    <p v-if="tasks.length === 0" class="muted">还没有任务。</p>

    <table v-if="tasks.length > 0">
      <thead>
        <tr>
          <th>任务</th>
          <th>群</th>
          <th>时间</th>
          <th>内容</th>
          <th>状态</th>
          <th>上次运行</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="t in tasks" :key="t.id">
          <td><strong>{{ t.name }}</strong></td>
          <td><code>{{ t.group.slice(0, 12) }}…</code></td>
          <td>{{ describe(t) }}</td>
          <td class="muted">{{ t.content.kind === 'fixed' ? t.content.text.slice(0, 24) : '模型读群聊生成' }}</td>
          <td>
            <span class="pill" :class="t.enabled ? 'good' : 'warn'">{{ t.enabled ? '开启' : '关闭' }}</span>
          </td>
          <td class="muted">{{ lastRun(t.lastRunAt) }}</td>
          <td style="white-space: nowrap">
            <button type="button" :disabled="busy === t.id" @click="runNow(t)">立刻运行</button>
            <button type="button" :disabled="busy === t.id" @click="edit(t)">编辑</button>
            <button type="button" :disabled="busy === t.id" @click="remove(t)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="hint">
      「立刻运行」无视时间表直接发 —— 时间表故意分散在一天里，靠等待没法验证它是否工作。
      它<strong>不会占用当天的额度</strong>，所以测试不会让真正的发送被跳过。
    </p>
  </div>

  <div class="card">
    <h2>从旧「发牢骚」配置迁移</h2>
    <p class="muted">
      旧的发牢骚配置会在下一次群消息到达时自动转成定时任务。如果现在就想转（比如群里很久没动静），可以手动执行。
      迁移是幂等的，重复执行不会产生重复任务；旧配置会<strong>保留</strong>，方便回退。
    </p>
    <button type="button" :disabled="busy === 'migrate'" @click="migrate">立刻迁移旧配置</button>
  </div>
</template>
