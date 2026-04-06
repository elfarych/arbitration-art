<template>
  <q-dialog v-model="internalValue" @hide="onHide">
    <q-card dark class="bg-dark text-white border-radius-md" style="width: 800px; max-width: 90vw;">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6 text-weight-bold">История сделок</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section>
        <q-table
          :rows="trades"
          :columns="columns"
          row-key="id"
          dark
          flat
          class="bg-transparent"
          :loading="loading"
          :pagination="{ rowsPerPage: 10 }"
          table-header-class="text-grey-6 text-weight-bold"
        >
          <template v-slot:body-cell-status="props">
            <q-td :props="props">
              <q-badge :color="props.value === 'closed' ? 'grey-8' : 'warning'" :text-color="props.value === 'closed' ? 'white' : 'dark'">
                {{ props.value === 'closed' ? 'Закрыта' : 'Открыта' }}
              </q-badge>
            </q-td>
          </template>

          <template v-slot:body-cell-profit="props">
            <q-td :props="props" class="text-weight-bold">
              <span v-if="props.row.status === 'open'" class="opacity-50">—</span>
              <span v-else :class="props.row.profit_percentage > 0 ? 'text-positive' : 'text-negative'">
                {{ props.row.profit_percentage > 0 ? '+' : '' }}{{ (parseFloat(props.row.profit_percentage) || 0).toFixed(3) }}%
              </span>
            </q-td>
          </template>

          <template v-slot:body-cell-opened_at="props">
            <q-td :props="props" class="text-caption">
              {{ new Date(props.value).toLocaleString() }}
            </q-td>
          </template>

          <template v-slot:body-cell-closed_at="props">
            <q-td :props="props" class="text-caption">
              {{ props.value ? new Date(props.value).toLocaleString() : '—' }}
            </q-td>
          </template>
        </q-table>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { botTradesApi, type EmulationTrade } from 'src/stores/bots/api/botConfig';

const props = defineProps<{
  modelValue: boolean;
  botId: number;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', val: boolean): void;
}>();

const internalValue = ref(props.modelValue);
const trades = ref<EmulationTrade[]>([]);
const loading = ref(false);

const columns = [
  { name: 'id', label: '#', field: 'id', align: 'left' },
  { name: 'status', label: 'Статус', field: 'status', align: 'left' },
  { name: 'amount', label: 'Объем', field: (row: any) => parseFloat(row.amount).toFixed(2), align: 'right' },
  { name: 'open_spread', label: 'Открытие', field: (row: any) => `${parseFloat(row.open_spread).toFixed(3)}%`, align: 'right' },
  { name: 'close_spread', label: 'Закрытие', field: (row: any) => row.close_spread ? `${parseFloat(row.close_spread).toFixed(3)}%` : '—', align: 'right' },
  { name: 'profit', label: 'Профит', field: 'profit_percentage', align: 'right' },
  { name: 'opened_at', label: 'Дата открытия', field: 'opened_at', align: 'right' },
  { name: 'closed_at', label: 'Дата закрытия', field: 'closed_at', align: 'right' },
] as any;

watch(() => props.modelValue, (val) => {
  internalValue.value = val;
  if (val) fetchTrades();
});

watch(internalValue, (val) => {
  emit('update:modelValue', val);
});

const fetchTrades = async () => {
  loading.value = true;
  try {
    const list = await botTradesApi.list(props.botId);
    trades.value = list.sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime());
  } catch (e) {
    console.error(e);
  } finally {
    loading.value = false;
  }
};

const onHide = () => {
  trades.value = [];
};

</script>
