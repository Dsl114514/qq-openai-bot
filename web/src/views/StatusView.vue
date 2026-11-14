<script setup lang="ts">
/**
 * Status: the Ed25519 capability probe and the audit-log retention control.
 *
 * The token-rotation and PoW-cache cards this page once hosted belonged to the DeepSeek web protocol and are
 * gone with it. What remains is everything an operator still needs to see about the deployment itself.
 */
import { ref } from 'vue';
import { api, type StatusResponse } from '../api';

const props = defineProps<{ status: StatusResponse | null }>();
const emit = defineEmits<{ changed: [] }>();

const busy = ref(false);
const purgeDays = ref(30);
const purgeOrigin = ref('');
const purgeNote = ref<string | null>(null);

async function purge() {
  busy.value = true;
  purgeNote.value = null;
  try {
    await api.postForm('/admin/purge', { days: String(purgeDays.value), origin: purgeOrigin.value });
    purgeNote.value = '已清理';
    emit('changed');
  } catch (e) {
    purgeNote.value = '失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="props.status" class="card">
    <h2>QQ 回调验签能力</h2>
    <p>
      <span v-if="props.status.ed25519.preferred" class="pill good">{{ props.status.ed25519.preferred }}</span>
      <span v-else class="pill bad">无可用导入路径</span>
    </p>
    <pre>{{ props.status.ed25519.detail.join('\n') }}</pre>
    <p class="muted">
      私钥在多数运行时的 WebCrypto 里不允许带 verify 用途，必须先导出公钥再作为公钥导入。这里是实测结果。
    </p>
  </div>

  <div class="card">
    <h2>用量与保留</h2>
    <form @submit.prevent="purge">
      <div class="row">
        <div>
          <label>删除早于（天）</label>
          <input v-model.number="purgeDays" type="number" min="0" size="6" />
        </div>
        <div>
          <label>仅限来源</label>
          <select v-model="purgeOrigin">
            <option value="">全部</option>
            <option value="qq">qq（腾讯运营规范要求终止服务时删除用户数据）</option>
            <option value="access_key">access_key</option>
            <option value="workbench">workbench</option>
          </select>
        </div>
        <div><button type="submit" :disabled="busy">清理</button></div>
      </div>
    </form>
    <p v-if="purgeNote" class="hint">{{ purgeNote }}</p>
  </div>
</template>
