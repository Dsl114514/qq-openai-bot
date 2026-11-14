<script setup lang="ts">
/**
 * QQ connection: identity, environment, groups, and scheduled interjections.
 *
 * THE GROUP PICKER IS THE POINT of this view's design. An earlier version asked the operator to paste a
 * `group_openid`, while the session list displayed the INTERNAL session identifier
 * (`group:<group>:<member>`) — so the value that got pasted never matched any event, the config saved
 * successfully, and the feature silently never fired. See ADR-0015.
 *
 * So the group is a DROPDOWN of groups discovered from real events, and there is no free-text field to get
 * wrong. The server refuses an unknown id too, but the client should not be able to produce one.
 */
import { ref, computed } from 'vue';
import { api, fmtDuration, fmtTime, type StatusResponse } from '../api';

const props = defineProps<{ status: StatusResponse | null }>();
const emit = defineEmits<{ changed: [] }>();

const note = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

/**
 * The webhook URL, built from the page's own origin.
 *
 * `location` must be captured here rather than written in the template. Vue templates resolve names
 * against the COMPONENT INSTANCE only, never against globals — so `{{ location.origin }}` in markup is an
 * undefined property and reading it THROWS, which blanks the whole view with no visible error. That is
 * exactly how this page presented: clicking QQ 接入 showed nothing.
 */
const webhookUrl = `${location.origin}/qq/webhook`;

const form = ref({
  group: '',
  perDay: 1,
  mode: 'random' as 'random' | 'fixed',
  at: '',
  text: '',
  enabled: true,
});

const groups = computed(() => props.status?.groups ?? []);
const interjections = computed(() => props.status?.interjections ?? []);
const validIds = computed(() => new Set(groups.value.map((g) => g.openid)));

const qq = computed(() => props.status?.qq ?? null);

async function save() {
  busy.value = true;
  note.value = null;
  error.value = null;
  try {
    await api.postForm('/admin/qq/interject', {
      group: form.value.group,
      perDay: String(form.value.perDay),
      mode: form.value.mode,
      at: form.value.at,
      text: form.value.text,
      ...(form.value.enabled ? { enabled: 'on' } : {}),
    });
    note.value = '已保存';
    emit('changed');
  } catch (e) {
    // The server rejects an unknown group id with an explanation; showing it is the whole point of
    // validating server-side rather than trusting this form.
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function fireNow(group: string) {
  busy.value = true;
  note.value = null;
  error.value = null;
  try {
    await api.postForm('/admin/qq/interject-test', { group });
    note.value = `已向 ${group.slice(0, 12)}… 发送一条测试消息`;
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function clear(group: string) {
  if (!confirm(`清除 ${group} 的发牢骚配置？`)) return;
  busy.value = true;
  try {
    await api.postForm('/admin/qq/interject-clear', { group });
    note.value = '已清除';
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** Flags a stored group id that has never appeared in a real event. */
function isUnknown(group: string): boolean {
  return !validIds.value.has(group);
}
</script>

<template>
  <div v-if="error" class="banner bad">{{ error }}</div>
  <div v-if="note" class="banner good">{{ note }}</div>

  <div class="card">
    <h2>机器人身份</h2>
    <template v-if="qq">
      <p v-if="qq.identity?.status === 200">
        <span class="pill good">已连接</span>
        <strong>{{ (qq.identity.body as any).username }}</strong>
        <span v-if="(qq.identity.body as any).robot_uin">
          · QQ 号 <code>{{ (qq.identity.body as any).robot_uin }}</code>
        </span>
      </p>
      <p v-else><span class="pill bad">无法连接</span> {{ qq.error ?? '未知错误' }}</p>

      <table>
        <tbody>
          <tr>
            <th>AppID</th>
            <td><code>{{ qq.appId ?? '（未配置）' }}</code></td>
          </tr>
          <tr>
            <th>API 主机</th>
            <td>
              <code>{{ qq.apiHost }}</code>
              <span class="pill" :class="qq.sandbox ? 'warn' : 'good'">{{ qq.sandbox ? '沙箱' : '正式' }}</span>
            </td>
          </tr>
          <tr>
            <th>回调地址</th>
            <td><code>{{ webhookUrl }}</code></td>
          </tr>
        </tbody>
      </table>

      <p v-if="qq.shareUrl" style="margin-top: 10px">
        <a :href="qq.shareUrl" target="_blank" rel="noopener">
          <button class="primary" type="button">打开机器人资料卡（在 QQ 里添加）</button>
        </a>
      </p>
      <p class="hint">用<strong>手机 QQ</strong>打开。电脑版对资料卡的支持不完整。</p>
    </template>
    <p v-else class="muted">加载中…</p>
  </div>

  <div class="card">
    <h2>发牢骚（定时主动发言）</h2>
    <p class="muted">机器人<b>自己找时机</b>在群里说一句，不需要有人 @ 它。</p>

    <table>
      <tbody>
        <tr>
          <th>触发方式</th>
          <td>
            <b>随机时间</b> —— 每天抽一个时间点（不是「每次请求掷骰子」，那样几乎立刻发）<br />
            <b>固定时间</b> —— 每天在指定时刻发
          </td>
        </tr>
        <tr>
          <th>内容来源</th>
          <td>留空 → 模型<b>读取群友最近的聊天</b>接一句；填了 → 直接发这段固定内容</td>
        </tr>
      </tbody>
    </table>

    <table v-if="interjections.length > 0" style="margin-top: 12px">
      <thead>
        <tr>
          <th>群</th>
          <th>状态</th>
          <th class="num">今日</th>
          <th>下次</th>
          <th>内容</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in interjections" :key="g.group">
          <td>
            <code>{{ g.group.slice(0, 12) }}…</code>
            <span v-if="isUnknown(g.group)" class="pill bad">无效</span>
          </td>
          <td>
            <span class="pill" :class="g.config.enabled ? 'good' : 'warn'">
              {{ g.config.enabled ? '开启' : '关闭' }}
            </span>
            <span class="pill note">{{ g.config.mode === 'fixed' ? '固定' : '随机' }}</span>
          </td>
          <td class="num">{{ g.sent }} / {{ g.config.perDay }}</td>
          <td class="muted">{{ g.nextDueAt ? fmtTime(g.nextDueAt) : '—' }}</td>
          <td class="muted">{{ g.config.text ?? '模型读群聊生成' }}</td>
          <td style="white-space: nowrap">
            <button type="button" :disabled="busy" @click="fireNow(g.group)">立刻发一条</button>
            <button type="button" :disabled="busy" @click="clear(g.group)">清除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted" style="margin-top: 8px">还没有配置任何群。</p>

    <form style="margin-top: 14px" @submit.prevent="save">
      <div class="row">
        <div style="min-width: 300px">
          <label>群</label>
          <select v-if="groups.length > 0" v-model="form.group" style="width: 100%">
            <option v-for="g in groups" :key="g.openid" :value="g.openid">{{ g.label }}</option>
          </select>
          <input
            v-else
            v-model="form.group"
            style="width: 100%"
            placeholder="还没有已知的群 —— 先在群里 @ 一次机器人"
          />
        </div>
        <div>
          <label>每天次数</label>
          <input v-model.number="form.perDay" type="number" min="0" max="10" size="4" />
        </div>
        <div>
          <label>方式</label>
          <select v-model="form.mode">
            <option value="random">随机时间</option>
            <option value="fixed">固定时间</option>
          </select>
        </div>
        <div>
          <label>固定时间</label>
          <input v-model="form.at" placeholder="09:30" size="7" />
        </div>
      </div>
      <div class="row" style="margin-top: 8px">
        <div style="flex: 1; min-width: 280px">
          <label>固定内容（留空则由模型读群聊生成）</label>
          <input v-model="form.text" style="width: 100%" placeholder="留空 = 让模型根据群友最近的话接一句" />
        </div>
        <div>
          <label>启用</label>
          <input v-model="form.enabled" type="checkbox" />
        </div>
        <div><button class="primary" type="submit" :disabled="busy">保存</button></div>
      </div>
    </form>

    <p class="hint">
      <strong>必须从下拉里选群</strong> —— 那是平台的 <code>group_openid</code>。会话列表里显示的是内部会话标识
      （形如 <code>group:群:成员</code>），填进去消息会发往不存在的路径，而且<strong>不会报错</strong>。
      <br />「立刻发一条」无视时间表直接发 —— 时间表故意不可预测，靠等待没法验证它是否工作。
    </p>
  </div>

  <div class="card">
    <h2>为什么后台显示「离线」</h2>
    <p>
      QQ 机器人有<strong>两套互斥的收消息方式</strong>，后台那个「离线 / 重新连接」是
      <strong>WebSocket 模式</strong>的状态灯。
    </p>
    <table>
      <thead>
        <tr><th>方式</th><th>怎么工作</th><th>能用吗</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>WebSocket</td>
          <td>程序主动连上去，维持长连接</td>
          <td><span class="pill bad">不能</span> Worker 无法维持长连接</td>
        </tr>
        <tr>
          <td><b>Webhook</b></td>
          <td>平台主动 POST 到你的 HTTPS 地址</td>
          <td><span class="pill good">可以</span> 本项目用的就是它</td>
        </tr>
      </tbody>
    </table>
    <p class="hint">
      所以「离线」<strong>不是故障</strong> —— 回调配好了就照常收发消息。反之，如果点了「重新连接」改成 WebSocket，
      本项目就收不到消息了。
    </p>
  </div>
</template>
