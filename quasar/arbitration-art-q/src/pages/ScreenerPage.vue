<template>
  <q-page class="q-pa-lg text-white">
    <div class="row items-center justify-between q-mb-lg">
      <h4 class="q-my-none text-h5 text-weight-bold">Скринер Спредов</h4>
      <q-btn
        color="primary"
        icon="refresh"
        label="Обновить"
        no-caps
        :loading="store.loading"
        @click="store.scanSpreads()"
        unelevated
      />
    </div>

    <!-- Controls -->
    <q-card class="bg-dark q-mb-lg border-radius-md" flat>
      <q-card-section class="row q-col-gutter-md items-center">
        <div class="col-12 col-md-3">
          <q-select
            v-model="store.primaryExchange"
            :options="exchangeOptions"
            label="Биржа Открытия"
            dark
            outlined
            dense
            emit-value
            map-options
            options-dense
          />
        </div>
        <div class="col-12 col-md-1 flex flex-center">
          <q-icon name="arrow_forward" size="sm" color="grey-6" />
        </div>
        <div class="col-12 col-md-3">
          <q-select
            v-model="store.secondaryExchange"
            :options="exchangeOptions"
            label="Биржа Закрытия"
            dark
            outlined
            dense
            emit-value
            map-options
            options-dense
          />
        </div>
        <div class="col-12 col-md-3">
          <q-select
            v-model="store.orderType"
            :options="[ { label: 'Покупка (Лонг)', value: 'buy' }, { label: 'Продажа (Шорт)', value: 'sell' } ]"
            label="Тип сделки"
            dark
            outlined
            dense
            emit-value
            map-options
            options-dense
          />
        </div>
      </q-card-section>
    </q-card>

    <!-- Table -->
    <q-card class="bg-dark border-radius-md" flat>
      <q-table
        :rows="store.results"
        :columns="columns"
        row-key="coin"
        dark
        flat
        bordered
        :loading="store.loading"
        :pagination="{ rowsPerPage: 50 }"
        class="bg-transparent"
        table-header-class="text-grey-6"
      >
        <template v-slot:body-cell-spread="props">
          <q-td :props="props">
            <span :class="props.row.spread > 0.5 ? 'text-positive text-weight-bold' : (props.row.spread > 0 ? 'text-positive' : 'text-negative')">
              <q-icon v-if="props.row.spread > 0.5" name="local_fire_department" color="warning" size="xs" class="q-mr-xs" />
              {{ props.row.spread > 0 ? '+' : '' }}{{ props.value.toFixed(3) }}%
            </span>
          </q-td>
        </template>
        
        <template v-slot:body-cell-coin="props">
          <q-td :props="props">
            <div class="text-weight-bold text-subtitle2">{{ props.value }}</div>
          </q-td>
        </template>

        <template v-slot:body-cell-primaryPrice="props">
          <q-td :props="props">
            <div class="text-caption text-grey-4">
              {{ props.value.toFixed(props.value < 1 ? 5 : 2) }}
            </div>
          </q-td>
        </template>

        <template v-slot:body-cell-secondaryPrice="props">
          <q-td :props="props">
            <div class="text-caption text-grey-4">
              {{ props.value.toFixed(props.value < 1 ? 5 : 2) }}
            </div>
          </q-td>
        </template>

      </q-table>
    </q-card>

  </q-page>
</template>

<script setup lang="ts">
import { useScreenerStore } from 'src/stores/screener/screener.store';

const store = useScreenerStore();

const exchangeOptions = [
  { label: 'Binance Futures', value: 'binance_futures' },
  { label: 'MEXC Futures', value: 'mexc_futures' },
  { label: 'Bybit', value: 'bybit_futures' },
  { label: 'Binance Spot', value: 'binance_spot' }
];

const columns = [
  { name: 'coin', label: 'Монета', field: 'coin', align: 'left', sortable: true },
  { name: 'primaryPrice', label: 'Цена Открытия', field: 'primaryPrice', align: 'right', sortable: true },
  { name: 'secondaryPrice', label: 'Цена Закрытия', field: 'secondaryPrice', align: 'right', sortable: true },
  { name: 'spread', label: 'Спред', field: 'spread', align: 'right', sortable: true }
] as any;

</script>

<style scoped>
.border-radius-md {
  border-radius: 12px;
}
</style>
