<script setup lang="ts">
/**
 * Settings: global defaults, per-group overrides, access rules, and retention.
 *
 * WHY GROUP OVERRIDES ARE STORED AS PARTIALS AND DISPLAYED RESOLVED. The stored override says only what a
 * group DISAGREES with; the effective value is what actually applies. Showing only the override makes "I
 * turned thinking on globally but this group still does not use it" invisible, so both are shown — and a
 * blank field means "inherit", which is a real third state next to on and off.
 *
 * That third state is why the checkboxes are tri-state selects rather than checkboxes: a checkbox cannot
 * express "unset", and collapsing unset into "off" would silently override the global setting the first
 * time a group was edited.
 */
import { ref, computed, onMounted } from 'vue';
import {
  api,
  getSettings,
  saveGlobalSettings,
  saveGroupSettings,
  getAccess,
  saveAccess,
  getProvider,
  saveProvider,
  probeProvider,
  testProvider,
  diagnoseProvider,
  DIAGNOSE_SHAPES,
  type SettingsResponse,
  type Settings,
  type AccessRules,
  type KnownGroup,
  type ProviderView,
  type ProbeResult,
} from '../api';

const emit = defineEmits<{ changed: [] }>();

const settings = ref<SettingsResponse | null>(null);
const access = ref<{ rules: AccessRules; knownGroups: KnownGroup[] } | null>(null);
const error = ref<string | null>(null);
const note = ref<string | null>(null);
const busy = ref(false);

// Global form, seeded from the server.
const g = ref<Settings>({ modes: { thinking: false, search: false }, persona: '', allowProactive: true, model: '' });

// Per-group form. `thinking`/`search` are tri-state: '' = inherit, 'true'/'false' = override.
const selectedGroup = ref('');
const groupForm = ref({ thinking: '', search: '', persona: '', allowProactive: '', model: '' });

// Access form, one id per line.
const accessForm = ref({ mode: 'open' as 'open' | 'closed', users: '', groups: '', deniedUsers: '', deniedGroups: '' });

// Retention.
const purgeDays = ref(7);

// Provider. Edits are made on a COPY, so a failed save cannot leave the form showing values the server never
// accepted. Keys are held separately per endpoint and blank means "unchanged", which is why they are not part
// of the endpoint object.
interface EndpointDraft {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  headersText: string;
  /** Blank = leave the stored key alone; a value = replace it. */
  key: string;
}

const provider = ref<ProviderView | null>(null);
// Exactly one provider kind remains, so this ref is a constant rather than a state: the save logic and the
// probe button still key off it, and a stored 'deepseek-web' kind from the old system is coerced server-side.
const providerKind = ref<'openai-compat'>('openai-compat');
const timeoutMs = ref(30000);
const drafts = ref<EndpointDraft[]>([]);
const providerNote = ref<string | null>(null);
const providerError = ref<string | null>(null);
const probeResults = ref<ProbeResult[]>([]);
const probeNote = ref<string | null>(null);
const probing = ref<string | null>(null);

/** Results of the real-completion test, kept separate from the models probe so the two are never confused. */
const completionNote = ref<string | null>(null);
const completionResults = ref<ProbeResult[]>([]);

/** Result of a single-shape diagnostic, plus which shape was asked for. */
const diagnoseNote = ref<string | null>(null);
const diagnoseOk = ref(false);
const diagnoseShape = ref('baseline');

/** A fresh draft, used for the "add endpoint" button. */
function blankDraft(): EndpointDraft {
  return { id: '', label: '备用', baseUrl: '', model: '', enabled: true, headersText: '', key: '' };
}

/** Headers as `Name: value` lines — the shape a person can read and edit. */
const headersToText = (h: Record<string, string>): string =>
  Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

/** Seed the drafts from the server's view. */
function seedDrafts(view: ProviderView) {
  drafts.value = view.endpoints.map((e) => ({
    id: e.id,
    label: e.label,
    baseUrl: e.baseUrl,
    model: e.model,
    enabled: e.enabled,
    headersText: headersToText(e.headers),
    key: '',
  }));
  if (drafts.value.length === 0) drafts.value = [blankDraft()];
}

/**
 * The URL a request will actually go to, computed client-side for immediate feedback.
 *
 * Mirrors the server's `completionsUrl`, deliberately: showing the operator the real URL before they save is
 * what turns a missing `/v1` from a 404-after-save into something visible while typing.
 */
function resolvedUrl(baseUrl: string): string {
  const base = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function addEndpoint() {
  if (drafts.value.length >= 8) {
    providerError.value = '最多 8 个端点。';
    return;
  }
  drafts.value.push(blankDraft());
}

/**
 * The model names a connection test discovered for one endpoint.
 *
 * MEASURED MOTIVATION: a model name was typed as `d`, and the resulting failure ("empty reply") gave no hint
 * that the name was the problem — it looked like the provider was misbehaving. Offering the provider's actual
 * list as autocomplete removes the opportunity for that typo without taking away free-text entry, because an
 * endpoint may serve a model it does not list.
 */
function modelsFor(endpointId: string): string[] {
  if (!endpointId) return [];
  return probeResults.value.find((r) => r.id === endpointId)?.models ?? [];
}

function removeEndpoint(index: number) {
  drafts.value.splice(index, 1);
  if (drafts.value.length === 0) drafts.value = [blankDraft()];
}

/** Move an endpoint up or down — the order IS the failover priority, so it has to be editable. */
function moveEndpoint(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= drafts.value.length) return;
  const copy = [...drafts.value];
  const [item] = copy.splice(index, 1);
  copy.splice(target, 0, item);
  drafts.value = copy;
}

async function saveProviderSettings() {
  busy.value = true;
  providerNote.value = null;
  providerError.value = null;
  try {
    const fields: Record<string, string> = {
      kind: providerKind.value,
      timeoutMs: String(timeoutMs.value),
    };

    if (providerKind.value === 'openai-compat') {
      // Sent as JSON: a list of objects cannot be expressed in form fields without inventing a flat naming
      // scheme that is worse to read and easier to get wrong.
      fields.endpoints = JSON.stringify(
        drafts.value.map((d) => ({
          ...(d.id ? { id: d.id } : {}),
          label: d.label,
          baseUrl: d.baseUrl,
          model: d.model,
          enabled: d.enabled,
          headers: d.headersText,
        })),
      );
      // Keys are separate fields so the server can tell "unchanged" from "remove". Only non-blank ones are
      // sent, which is what stops saving the URL from wiping a key.
      for (const d of drafts.value) {
        if (d.id && d.key.trim()) fields[`key:${d.id}`] = d.key.trim();
      }
    }

    const r = await saveProvider(fields);
    if (r.ok) {
      providerNote.value = r.detail;
      if (r.provider) {
        provider.value = r.provider;
        providerKind.value = r.provider.kind;
        timeoutMs.value = r.provider.timeoutMs;
        seedDrafts(r.provider);
      }
    } else {
      providerError.value = r.detail;
    }
    emit('changed');
  } catch (e) {
    providerError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** Replace one endpoint's key with an empty value, which is how the server reads "remove it". */
async function clearEndpointKey(endpointId: string, label: string) {
  if (!confirm(`删除端点「${label}」的 API Key？删除后如果它是唯一可用的端点，发消息会失败。`)) return;
  busy.value = true;
  try {
    const r = await saveProvider({ [`key:${endpointId}`]: '' });
    providerNote.value = r.detail;
    if (r.provider) provider.value = r.provider;
    emit('changed');
  } catch (e) {
    providerError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Test the connection.
 *
 * With no argument the SERVER tests every enabled endpoint, which is the question an operator actually has when
 * configuring a fallback: which of these work? With an id it tests just that one.
 */
async function runProbe(endpointId?: string) {
  probing.value = endpointId ?? 'all';
  probeResults.value = [];
  probeNote.value = null;
  try {
    const r = await probeProvider(endpointId);
    probeNote.value = r.detail;
    probeResults.value = r.results ?? [];
  } catch (e) {
    probeNote.value = e instanceof Error ? e.message : String(e);
  } finally {
    probing.value = null;
  }
}

/**
 * Send a real one-token completion.
 *
 * SEPARATE FROM THE PROBE on purpose: the probe proves the key is accepted and the URL resolves, but a valid key
 * with a model name the provider does not serve still fails — and that failure reads as the provider misbehaving.
 * This names it.
 */
async function runTest(draft: EndpointDraft) {
  probing.value = draft.id || draft.label;
  completionNote.value = null;
  completionResults.value = [];
  try {
    const r = await testProvider({
      ...(draft.id ? { endpointId: draft.id } : {}),
      // The CURRENT form value, not the saved one, so a model name can be tried before it is committed.
      ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    });
    completionNote.value = r.detail;
    completionResults.value = r.results ?? [];
  } catch (e) {
    completionNote.value = e instanceof Error ? e.message : String(e);
  } finally {
    probing.value = null;
  }
}

/**
 * Send ONE request in a chosen shape.
 *
 * ONE PER CALL on purpose: a burst of shapes trips the very rate limit it is investigating, and the result then
 * reads as "only the first shape works" when it is really "bursts are limited". That mistake was made here once.
 */
async function runDiagnose(draft: EndpointDraft) {
  probing.value = `diag:${draft.id || draft.label}`;
  diagnoseNote.value = null;
  try {
    const r = await diagnoseProvider({ ...(draft.id ? { endpointId: draft.id } : {}), shape: diagnoseShape.value });
    diagnoseOk.value = r.ok;
    diagnoseNote.value = r.detail;
  } catch (e) {
    diagnoseOk.value = false;
    diagnoseNote.value = e instanceof Error ? e.message : String(e);
  } finally {
    probing.value = null;
  }
}

const knownGroups = computed(() => settings.value?.knownGroups ?? []);
const overrideFor = computed(() => settings.value?.groups.find((x) => x.group === selectedGroup.value) ?? null);

/** `text` → lines, so a textarea of ids becomes an array without the user learning a syntax. */
const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

async function load() {
  try {
    const [s, a, p] = await Promise.all([getSettings(), getAccess(), getProvider()]);
    settings.value = s;
    access.value = a;
    g.value = { ...s.global, modes: { ...s.global.modes } };
    accessForm.value = {
      mode: a.rules.mode,
      users: a.rules.users.join('\n'),
      groups: a.rules.groups.join('\n'),
      deniedUsers: a.rules.deniedUsers.join('\n'),
      deniedGroups: a.rules.deniedGroups.join('\n'),
    };
    provider.value = p;
    providerKind.value = p.kind;
    timeoutMs.value = p.timeoutMs;
    seedDrafts(p);
    // Default the per-group picker to the first known group, so the section is usable without a guess.
    if (!selectedGroup.value && knownGroups.value.length > 0) {
      selectedGroup.value = knownGroups.value[0].openid;
      syncGroupForm();
    }
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** Load the selected group's stored override into the form, or blanks when it has none. */
function syncGroupForm() {
  const entry = overrideFor.value;
  const o = entry?.override ?? {};
  groupForm.value = {
    // '' means "no override", which is different from a stored false.
    thinking: o.modes?.thinking === undefined ? '' : String(o.modes.thinking),
    search: o.modes?.search === undefined ? '' : String(o.modes.search),
    persona: o.persona ?? '',
    allowProactive: o.allowProactive === undefined ? '' : String(o.allowProactive),
    model: o.model ?? '',
  };
}

async function saveGlobal() {
  busy.value = true;
  note.value = null;
  try {
    const r = await saveGlobalSettings({
      thinking: String(g.value.modes.thinking),
      search: String(g.value.modes.search),
      persona: g.value.persona,
      model: g.value.model,
      allowProactive: String(g.value.allowProactive),
    });
    note.value = r.detail;
    await load();
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function saveGroup() {
  if (!selectedGroup.value) return;
  busy.value = true;
  note.value = null;
  try {
    const fields: Record<string, string> = { group: selectedGroup.value };
    // Only send fields that carry a decision. An empty string means inherit, and sending it as a value
    // would override the global setting instead of deferring to it.
    if (groupForm.value.thinking !== '') fields.thinking = groupForm.value.thinking;
    if (groupForm.value.search !== '') fields.search = groupForm.value.search;
    if (groupForm.value.persona.trim()) fields.persona = groupForm.value.persona;
    if (groupForm.value.allowProactive !== '') fields.allowProactive = groupForm.value.allowProactive;
    if (groupForm.value.model.trim()) fields.model = groupForm.value.model;

    const r = await saveGroupSettings(fields);
    note.value = r.detail;
    await load();
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function clearGroup() {
  if (!selectedGroup.value || !confirm('清除这个群的设置，恢复继承全局默认？')) return;
  busy.value = true;
  try {
    const r = await saveGroupSettings({ group: selectedGroup.value, clear: 'on' });
    note.value = r.detail;
    await load();
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function saveAccessRules() {
  busy.value = true;
  note.value = null;
  try {
    const body = new URLSearchParams();
    body.set('mode', accessForm.value.mode);
    for (const [key, value] of Object.entries({
      users: accessForm.value.users,
      groups: accessForm.value.groups,
      deniedUsers: accessForm.value.deniedUsers,
      deniedGroups: accessForm.value.deniedGroups,
    })) {
      for (const id of lines(value)) body.append(key, id);
    }
    const res = await fetch('/admin/api/access', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const r = (await res.json()) as { ok: boolean; detail: string };
    note.value = r.detail;
    await load();
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function purgeSessions() {
  busy.value = true;
  note.value = null;
  try {
    const r = (await api.postForm('/admin/qq/purge-sessions', { days: String(purgeDays.value) })) as {
      ok: boolean;
      detail: string;
    };
    note.value = r.detail;
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-if="error" class="banner bad">{{ error }}</div>
  <div v-if="note" class="banner good">{{ note }}</div>

  <div class="card">
    <h2>模型来源</h2>
    <p class="muted">
      决定由谁回答消息。任何 <strong>OpenAI 兼容接口</strong>都可以接入 —— 官方 API、中转、自建网关。
      <strong>第一个启用的端点优先</strong>，失败时自动按顺序尝试后面的端点。
    </p>

    <div class="row" style="margin-bottom: 12px">
      <div>
        <label>超时（毫秒）</label>
        <input v-model.number="timeoutMs" type="number" min="1000" max="120000" size="7" />
      </div>
    </div>

      <p class="muted">
        <strong>第一个启用的端点优先</strong>，失败时自动按顺序尝试后面的。用 ↑↓ 调整顺序 —— 顺序就是优先级。
      </p>

      <div
        v-for="(d, i) in drafts"
        :key="i"
        style="border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 10px"
      >
        <div class="row" style="align-items: center; margin-bottom: 8px">
          <span class="pill" :class="i === 0 ? 'good' : 'note'">{{ i === 0 ? '首选' : `备用 ${i}` }}</span>
          <div>
            <label>名称</label>
            <input v-model="d.label" size="14" placeholder="主端点" />
          </div>
          <div>
            <label>启用</label>
            <input v-model="d.enabled" type="checkbox" />
          </div>
          <span style="flex: 1"></span>
          <button type="button" :disabled="i === 0" @click="moveEndpoint(i, -1)">↑</button>
          <button type="button" :disabled="i === drafts.length - 1" @click="moveEndpoint(i, 1)">↓</button>
          <button type="button" :disabled="drafts.length <= 1" @click="removeEndpoint(i)">删除</button>
        </div>

        <div class="row">
          <div style="flex: 1; min-width: 300px">
            <label>Base URL</label>
            <input v-model="d.baseUrl" style="width: 100%" placeholder="https://api.openai.com/v1" />
          </div>
          <div>
            <label>模型名</label>
            <!--
              A datalist, not a select. It offers the provider's ACTUAL model list as autocomplete while leaving
              the field free-text — an endpoint may serve a model it does not advertise, and a select would make
              that unreachable. The list is populated by the connection test above.
            -->
            <input v-model="d.model" size="22" placeholder="gpt-4o-mini" :list="`models-${i}`" />
            <datalist :id="`models-${i}`">
              <option v-for="m in modelsFor(d.id)" :key="m" :value="m" />
            </datalist>
          </div>
        </div>

        <p v-if="d.baseUrl" class="hint">
          请求会发往：<code>{{ resolvedUrl(d.baseUrl) }}</code>
          <span v-if="modelsFor(d.id).length"> · 已从「测试」获得 {{ modelsFor(d.id).length }} 个可用模型，模型名输入框可自动补全</span>
        </p>

        <div class="row" style="margin-top: 8px">
          <div style="flex: 1; min-width: 300px">
            <label>
              API Key
              <span v-if="provider?.endpoints[i]?.hasKey" class="muted">
                （已配置 {{ provider.endpoints[i].keyFingerprint }} · {{ provider.endpoints[i].keySource }}；留空 = 不改动）
              </span>
            </label>
            <input
              v-model="d.key"
              type="password"
              style="width: 100%"
              autocomplete="off"
              spellcheck="false"
              :placeholder="provider?.endpoints[i]?.hasKey ? '留空保持不变' : 'sk-...'" />
          </div>
          <div style="min-width: 200px">
            <label>额外请求头（每行一个 <code>Name: value</code>）</label>
            <textarea v-model="d.headersText" rows="2" style="width: 100%" placeholder="HTTP-Referer: https://example.com"></textarea>
          </div>
        </div>

        <div class="row" style="margin-top: 8px">
          <button type="button" :disabled="probing !== null" @click="runProbe(d.id || undefined)">
            {{ probing === (d.id || 'all') ? '测试中…' : '获取模型列表' }}
          </button>
          <button type="button" :disabled="probing !== null" @click="runTest(d)">
            {{ probing === (d.id || d.label) ? '对话中…' : '测试对话' }}
          </button>
          <button
            v-if="d.id && provider?.endpoints[i]?.hasKey"
            type="button"
            :disabled="busy"
            @click="clearEndpointKey(d.id, d.label)">删除 Key</button>
          <span class="hint">
            「获取模型列表」验证 Key 与 URL；「测试对话」额外验证<strong>模型名</strong> —— 用当前输入框里的值，保存前就能试。
          </span>
        </div>

        <div class="row" style="margin-top: 8px; align-items: flex-end">
          <div style="min-width: 280px">
            <label>诊断：换一种请求形态，看是不是被拦在门口</label>
            <select v-model="diagnoseShape" style="width: 100%">
              <option v-for="s in DIAGNOSE_SHAPES" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </div>
          <div>
            <button type="button" :disabled="probing !== null" @click="runDiagnose(d)">
              {{ probing === `diag:${d.id || d.label}` ? '诊断中…' : '发送这一种' }}
            </button>
          </div>
          <span class="hint">每次只发<strong>一个</strong>请求 —— 连发会打爆它自己的限流，结果就不可信了。</span>
        </div>
      </div>

      <div class="row">
        <button type="button" :disabled="drafts.length >= 8" @click="addEndpoint">+ 添加备用端点</button>
      </div>

    <div class="row" style="margin-top: 12px">
      <button class="primary" type="button" :disabled="busy" @click="saveProviderSettings">保存</button>
      <button
        type="button"
        :disabled="probing !== null"
        @click="runProbe()">{{ probing === 'all' ? '测试中…' : '测试全部端点' }}</button>
    </div>

    <div v-if="providerNote" class="banner good" style="margin-top: 10px">{{ providerNote }}</div>
    <div v-if="providerError" class="banner bad" style="margin-top: 10px">{{ providerError }}</div>

    <div v-if="probeNote" class="banner" :class="probeResults.some((r) => r.ok) ? 'good' : 'bad'" style="margin-top: 10px">
      {{ probeNote }}
      <div v-for="r in probeResults.filter((x) => x.models?.length)" :key="r.id" style="margin-top: 6px">
        <details>
          <summary>「{{ r.label }}」可用模型（{{ r.models?.length }}）</summary>
          <div style="max-height: 200px; overflow: auto; margin-top: 6px">
            <code v-for="m in r.models" :key="m" style="display: block">{{ m }}</code>
          </div>
        </details>
      </div>
    </div>

    <div
      v-if="completionNote"
      class="banner"
      :class="completionResults.some((r) => r.ok) ? 'good' : 'bad'"
      style="margin-top: 10px">
      <strong>对话测试</strong>：{{ completionNote }}
      <div v-for="r in completionResults" :key="r.id" class="muted" style="font-size: 12px; margin-top: 4px">
        {{ r.label }} · {{ r.ms }}ms
      </div>
    </div>

    <div v-if="diagnoseNote" class="banner" :class="diagnoseOk ? 'good' : 'bad'" style="margin-top: 10px">
      <strong>诊断</strong>：{{ diagnoseNote }}
    </div>

    <p class="hint">
      <strong>Base URL 要带 <code>/v1</code></strong>（例如 <code>https://api.openai.com/v1</code>）。
      少写 <code>/v1</code> 会返回 404，而 404 看起来很像密钥问题 —— 「测试」会把这两种情况分开告诉你。
      <br />Key 也可以放在 Worker secret <code>OPENAI_API_KEY</code> 里，那样不会进数据库，所有端点共用。
      <br /><strong>故障转移对什么有效</strong>：限流、额度用尽、超时、5xx。对 400 类错误无效 —— 请求本身有问题时换端点也一样失败，所以不会浪费你的额度。
    </p>
  </div>

  <div class="card">
    <h2>全局默认</h2>
    <p class="muted">
      所有群和私聊的默认行为。单个群可以在下面<strong>覆盖</strong>这些值，没有覆盖的群始终跟随这里。
    </p>
    <form @submit.prevent="saveGlobal">
      <div class="row">
        <div>
          <label>默认深度思考</label>
          <select v-model="g.modes.thinking">
            <option :value="false">关闭（更快）</option>
            <option :value="true">开启（回答更慢但更严谨）</option>
          </select>
        </div>
        <div>
          <label>默认联网搜索</label>
          <select v-model="g.modes.search">
            <option :value="false">关闭</option>
            <option :value="true">开启</option>
          </select>
        </div>
        <div>
          <label>允许主动发言</label>
          <select v-model="g.allowProactive">
            <option :value="true">允许</option>
            <option :value="false">禁止</option>
          </select>
        </div>
        <div>
          <label>模型标签</label>
          <input v-model="g.model" size="22" />
        </div>
      </div>
      <div style="margin-top: 8px">
        <label>全局人格 / 固定要求（留空则不加）</label>
        <textarea v-model="g.persona" rows="3" style="width: 100%" placeholder="例：用简体中文回答，语气轻松，不要用 emoji。"></textarea>
      </div>
      <div class="row" style="margin-top: 8px">
        <button class="primary" type="submit" :disabled="busy">保存全局</button>
        <span class="hint">每条消息开头的 <code>/think</code>、<code>/search</code>、<code>/fast</code> 仍然优先。</span>
      </div>
    </form>
  </div>

  <div class="card">
    <h2>按群覆盖</h2>
    <p class="muted">只设置需要与全局<strong>不同</strong>的项。<strong>留空 = 继承全局</strong>，这是三种状态而不是开关。</p>

    <p v-if="knownGroups.length === 0" class="muted">
      还没有已知的群。先在群里 @ 一次机器人，它才会出现在这里 —— 只有真正到过事件的群才可选。
    </p>

    <template v-else>
      <div class="row">
        <div style="min-width: 340px">
          <label>群</label>
          <select v-model="selectedGroup" style="width: 100%" @change="syncGroupForm">
            <option v-for="kg in knownGroups" :key="kg.openid" :value="kg.openid">{{ kg.label }}</option>
          </select>
        </div>
        <div>
          <span v-if="overrideFor?.overridden" class="pill good">已有覆盖</span>
          <span v-else class="pill note">继承全局</span>
        </div>
      </div>

      <form style="margin-top: 10px" @submit.prevent="saveGroup">
        <div class="row">
          <div>
            <label>深度思考</label>
            <select v-model="groupForm.thinking">
              <option value="">继承全局</option>
              <option value="true">开启</option>
              <option value="false">关闭</option>
            </select>
          </div>
          <div>
            <label>联网搜索</label>
            <select v-model="groupForm.search">
              <option value="">继承全局</option>
              <option value="true">开启</option>
              <option value="false">关闭</option>
            </select>
          </div>
          <div>
            <label>允许主动发言</label>
            <select v-model="groupForm.allowProactive">
              <option value="">继承全局</option>
              <option value="true">允许</option>
              <option value="false">禁止</option>
            </select>
          </div>
          <div>
            <label>模型标签</label>
            <input v-model="groupForm.model" placeholder="继承全局" size="20" />
          </div>
        </div>
        <div style="margin-top: 8px">
          <label>该群人格（留空则继承全局）</label>
          <textarea v-model="groupForm.persona" rows="2" style="width: 100%" placeholder="留空 = 使用全局人格"></textarea>
        </div>
        <div class="row" style="margin-top: 8px">
          <button class="primary" type="submit" :disabled="busy">保存该群</button>
          <button type="button" :disabled="busy || !overrideFor?.overridden" @click="clearGroup">清除覆盖</button>
        </div>
      </form>

      <table v-if="settings && settings.groups.length > 0" style="margin-top: 14px">
        <thead>
          <tr><th>群</th><th>思考</th><th>搜索</th><th>主动发言</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="entry in settings.groups" :key="entry.group">
            <td><code>{{ entry.group.slice(0, 14) }}…</code></td>
            <td>{{ entry.effective.modes.thinking ? '开' : '关' }}<span class="muted"> {{ entry.override.modes?.thinking === undefined ? '（继承）' : '（覆盖）' }}</span></td>
            <td>{{ entry.effective.modes.search ? '开' : '关' }}<span class="muted"> {{ entry.override.modes?.search === undefined ? '（继承）' : '（覆盖）' }}</span></td>
            <td>{{ entry.effective.allowProactive ? '允许' : '禁止' }}</td>
            <td><button type="button" @click="selectedGroup = entry.group; syncGroupForm()">编辑</button></td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>

  <div class="card">
    <h2>黑白名单</h2>
    <p class="muted">
      每行一个 id。<strong>黑名单始终优先</strong> —— 两边都有的 id 会被拒绝，否则「拉黑」就没有意义。
    </p>
    <form @submit.prevent="saveAccessRules">
      <div class="row">
        <div>
          <label>模式</label>
          <select v-model="accessForm.mode">
            <option value="open">所有人可用（黑名单生效）</option>
            <option value="closed">仅白名单可用（私聊机器人）</option>
          </select>
        </div>
      </div>

      <div class="row" style="margin-top: 10px; align-items: flex-start">
        <div style="flex: 1; min-width: 220px">
          <label>允许的群（白名单，每行一个）</label>
          <textarea v-model="accessForm.groups" rows="4" style="width: 100%" placeholder="从下面的已知群复制 openid"></textarea>
        </div>
        <div style="flex: 1; min-width: 220px">
          <label>允许的用户（白名单，每行一个）</label>
          <textarea v-model="accessForm.users" rows="4" style="width: 100%" placeholder="用户 openid"></textarea>
        </div>
      </div>

      <div class="row" style="margin-top: 10px; align-items: flex-start">
        <div style="flex: 1; min-width: 220px">
          <label>禁止的群（黑名单）</label>
          <textarea v-model="accessForm.deniedGroups" rows="3" style="width: 100%"></textarea>
        </div>
        <div style="flex: 1; min-width: 220px">
          <label>禁止的用户（黑名单）</label>
          <textarea v-model="accessForm.deniedUsers" rows="3" style="width: 100%"></textarea>
        </div>
      </div>

      <div class="row" style="margin-top: 10px">
        <button class="primary" type="submit" :disabled="busy">保存名单</button>
        <span class="hint">
          被拒绝的消息<strong>不会被回复，也不会告诉对方为什么</strong> —— 但会记进审计台，方便你自己核对。
        </span>
      </div>
    </form>

    <details v-if="knownGroups.length > 0" style="margin-top: 10px">
      <summary class="muted">已知群（点开复制 openid）</summary>
      <table>
        <tbody>
          <tr v-for="kg in knownGroups" :key="kg.openid">
            <td>{{ kg.label }}</td>
            <td><code>{{ kg.openid }}</code></td>
          </tr>
        </tbody>
      </table>
    </details>
  </div>

  <div class="card">
    <h2>会话清理</h2>
    <p class="muted">
      删除一段时间没有活动的会话记录。QQ 平台要求机器人在停止服务时删除用户数据，这里是那个能力。
    </p>
    <form class="row" @submit.prevent="purgeSessions">
      <div>
        <label>删除闲置超过（天）</label>
        <input v-model.number="purgeDays" type="number" min="0" size="6" />
      </div>
      <div><button type="submit" :disabled="busy">清理会话</button></div>
      <span class="hint">填 0 = 删除全部会话（上下文会全部丢失，不可恢复）。</span>
    </form>
  </div>
</template>
