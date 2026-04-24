<template>
  <q-page padding class="profile-page">
    <div class="row items-center justify-between q-mb-lg">
      <div>
        <h1 class="text-h5 text-title-color text-weight-bold q-my-none">Профиль</h1>
        <div class="text-caption text-grey-5 q-mt-xs">Аккаунт и ключи бирж</div>
      </div>

      <q-btn flat round no-caps icon="refresh" color="grey-4" :loading="loading" @click="loadProfileData">
        <q-tooltip>Обновить</q-tooltip>
      </q-btn>
    </div>

    <div class="profile-grid">
      <q-card dark flat bordered class="bg-dark account-panel">
        <q-card-section>
          <div class="text-subtitle1 text-title-color text-weight-bold q-mb-md">Аккаунт</div>
          <div class="profile-row">
            <span class="text-grey-5">Email</span>
            <span>{{ authStore.currentUser?.email || '-' }}</span>
          </div>
          <div class="profile-row">
            <span class="text-grey-5">Username</span>
            <span>{{ authStore.currentUser?.username || '-' }}</span>
          </div>
          <div class="profile-row">
            <span class="text-grey-5">Дата регистрации</span>
            <span>{{ formatDate(authStore.currentUser?.date_joined) }}</span>
          </div>
        </q-card-section>

        <q-separator dark />

        <q-card-actions align="right">
          <q-btn flat no-caps color="negative" icon="logout" label="Выйти" @click="logout" />
        </q-card-actions>
      </q-card>

      <q-card dark flat bordered class="bg-dark keys-panel">
        <q-card-section>
          <div class="row items-center justify-between q-mb-md">
            <div>
              <div class="text-subtitle1 text-title-color text-weight-bold">API ключи</div>
              <div class="text-caption text-grey-5">Пустые поля не меняют сохраненные значения</div>
            </div>
            <q-badge color="info" text-color="white" label="masked" />
          </div>

          <div v-if="loading" class="text-center q-my-xl">
            <q-spinner color="primary" size="md" />
          </div>

          <q-form v-else class="exchange-form" @submit.prevent="saveKeys">
            <section v-for="item in exchangeForms" :key="item.id" class="exchange-section">
              <div class="row items-center justify-between q-mb-sm">
                <div class="row items-center q-gutter-sm">
                  <div class="exchange-title">{{ item.label }}</div>
                  <q-badge :color="isConfigured(item.id) ? 'positive' : 'grey-7'" :label="isConfigured(item.id) ? 'Настроено' : 'Не задано'" />
                </div>
                <q-btn
                  flat
                  dense
                  no-caps
                  color="negative"
                  icon="delete"
                  label="Очистить"
                  :disable="!isConfigured(item.id)"
                  @click="confirmClear(item.id)"
                />
              </div>

              <div v-if="stateFor(item.id).api_key_preview || stateFor(item.id).secret_preview" class="preview-row q-mb-sm">
                <span>API key: {{ stateFor(item.id).api_key_preview || '-' }}</span>
                <span>Secret: {{ stateFor(item.id).secret_preview || '-' }}</span>
              </div>

              <div class="exchange-fields">
                <q-input
                  v-model.trim="form[item.apiKeyField]"
                  :label="`${item.label} API key`"
                  outlined
                  dense
                  dark
                  autocomplete="off"
                />
                <q-input
                  v-model.trim="form[item.secretField]"
                  :label="`${item.label} secret`"
                  outlined
                  dense
                  dark
                  :type="visibleSecrets[item.id] ? 'text' : 'password'"
                  autocomplete="new-password"
                >
                  <template #append>
                    <q-btn
                      flat
                      round
                      dense
                      no-caps
                      :icon="visibleSecrets[item.id] ? 'visibility_off' : 'visibility'"
                      @click="visibleSecrets[item.id] = !visibleSecrets[item.id]"
                    />
                  </template>
                </q-input>
              </div>
            </section>

            <q-card-actions align="right" class="q-px-none q-pt-md">
              <q-btn flat no-caps color="grey-4" label="Сбросить ввод" @click="resetForm" />
              <q-btn type="submit" no-caps color="primary" icon="save" label="Сохранить заполненные" :loading="saving" />
            </q-card-actions>
          </q-form>
        </q-card-section>
      </q-card>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { storeToRefs } from 'pinia';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import { useAuthStore } from 'stores/auth';
import { useProfileStore } from 'stores/profile/profile.store';
import type { ExchangeId, ExchangeKeysPayload } from 'stores/profile/api/exchangeKeys';

type ExchangeFormConfig = {
  id: ExchangeId;
  label: string;
  apiKeyField: keyof ExchangeKeysPayload;
  secretField: keyof ExchangeKeysPayload;
};

const $q = useQuasar();
const router = useRouter();
const authStore = useAuthStore();
const profileStore = useProfileStore();
const { exchangeKeys, loading, saving } = storeToRefs(profileStore);

const exchangeForms: ExchangeFormConfig[] = [
  { id: 'binance', label: 'Binance', apiKeyField: 'binance_api_key', secretField: 'binance_secret' },
  { id: 'bybit', label: 'Bybit', apiKeyField: 'bybit_api_key', secretField: 'bybit_secret' },
  { id: 'gate', label: 'Gate', apiKeyField: 'gate_api_key', secretField: 'gate_secret' },
  { id: 'mexc', label: 'MEXC', apiKeyField: 'mexc_api_key', secretField: 'mexc_secret' },
];

const emptyForm: Required<ExchangeKeysPayload> = {
  binance_api_key: '',
  binance_secret: '',
  bybit_api_key: '',
  bybit_secret: '',
  gate_api_key: '',
  gate_secret: '',
  mexc_api_key: '',
  mexc_secret: '',
};

const form = reactive<Required<ExchangeKeysPayload>>({ ...emptyForm });

const visibleSecrets = reactive<Record<ExchangeId, boolean>>({
  binance: false,
  bybit: false,
  gate: false,
  mexc: false,
});

function stateFor(exchange: ExchangeId) {
  return exchangeKeys.value[exchange];
}

function isConfigured(exchange: ExchangeId) {
  const state = stateFor(exchange);
  return state.has_api_key || state.has_secret;
}

function buildChangedPayload(): ExchangeKeysPayload {
  return Object.fromEntries(
    Object.entries(form).filter(([, value]) => value !== ''),
  ) as ExchangeKeysPayload;
}

function resetForm() {
  Object.assign(form, emptyForm);
}

async function saveKeys() {
  const payload = buildChangedPayload();
  if (Object.keys(payload).length === 0) {
    $q.notify({ color: 'warning', message: 'Заполните хотя бы одно поле' });
    return;
  }

  try {
    await profileStore.updateExchangeKeys(payload);
    resetForm();
    $q.notify({ color: 'positive', message: 'API ключи сохранены' });
  } catch (error) {
    console.error(error);
    $q.notify({ color: 'negative', message: 'Не удалось сохранить API ключи' });
  }
}

function confirmClear(exchange: ExchangeId) {
  const label = exchangeForms.find((item) => item.id === exchange)?.label ?? exchange;
  $q.dialog({
    title: `Очистить ${label}`,
    message: 'Удалить сохраненные API key и secret для этой биржи?',
    cancel: true,
    persistent: true,
    dark: true,
    color: 'negative',
  }).onOk(async () => {
    try {
      await profileStore.clearExchangeKeys(exchange);
      resetForm();
      $q.notify({ color: 'positive', message: `${label} ключи очищены` });
    } catch (error) {
      console.error(error);
      $q.notify({ color: 'negative', message: 'Не удалось очистить ключи' });
    }
  });
}

function formatDate(value?: string) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

async function logout() {
  await authStore.logout();
  await router.push('/login');
}

async function loadProfileData() {
  await Promise.all([
    authStore.currentUser ? Promise.resolve() : authStore.fetchUser(),
    profileStore.fetchExchangeKeys(),
  ]);
}

onMounted(() => {
  void loadProfileData();
});
</script>

<style lang="sass" scoped>
.profile-page
  max-width: 1280px
  margin: 0 auto

.profile-grid
  display: grid
  grid-template-columns: minmax(260px, 360px) minmax(0, 1fr)
  gap: 16px

.account-panel,
.keys-panel
  border-color: $blue-dark
  border-radius: $generic-border-radius

.profile-row
  display: flex
  justify-content: space-between
  gap: 16px
  padding: 10px 0
  border-bottom: 1px solid rgba(255, 255, 255, 0.06)
  &:last-child
    border-bottom: 0

.exchange-form
  display: flex
  flex-direction: column
  gap: 14px

.exchange-section
  padding: 14px
  border: 1px solid rgba(255, 255, 255, 0.08)
  border-radius: $generic-border-radius
  background: rgba(255, 255, 255, 0.025)

.exchange-title
  color: $title-color
  font-weight: 700

.exchange-fields
  display: grid
  grid-template-columns: repeat(2, minmax(0, 1fr))
  gap: 14px

.preview-row
  display: flex
  flex-wrap: wrap
  gap: 12px
  color: $text-color
  font-size: 12px
  opacity: 0.75

.text-title-color
  color: $title-color !important

@media (max-width: 900px)
  .profile-grid,
  .exchange-fields
    grid-template-columns: 1fr
</style>
