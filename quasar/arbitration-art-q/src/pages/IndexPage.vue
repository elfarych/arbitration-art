<template>
  <q-page padding class="bot-list-page">
    <div class="row items-center justify-between q-mb-lg">
      <h1 class="text-h5 text-title-color text-weight-bold q-my-none">Мои боты</h1>
      <q-btn color="primary" text-color="white" no-caps label="+ Создать" @click="openCreateDialog" />
    </div>

    <div v-if="loading" class="text-center q-my-xl">
      <q-spinner color="primary" size="lg" />
      <div class="text-text-color q-mt-md opacity-70">Загрузка ботов...</div>
    </div>
    
    <div v-else-if="bots.length === 0" class="text-center q-my-xl border-radius-sm bg-surface q-pa-xl">
      <div class="text-text-color q-mb-md opacity-70">У вас пока нет настроенных ботов</div>
      <q-btn color="primary" outline no-caps label="Создать первого бота" @click="openCreateDialog" />
    </div>

    <div v-else class="bot-cards-grid">
      <BotCard 
        v-for="bot in bots" :key="bot.id"
        :bot="bot" 
        @toggle="toggleBot" 
        @edit="openEditDialog" 
        @delete="deleteBot" 
        @history="openHistory"
        @force-close="forceCloseBot"
      />
    </div>

    <!-- Modals to be implemented next -->
    <BotFormDialog 
      v-model="isFormOpen" 
      :bot="editingBot" 
    />
    
    <SpreadHistoryDialog 
      v-model="isHistoryOpen" 
      :bot="historyBot" 
    />
  </q-page>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import type { BotConfig } from 'src/stores/bots/api/botConfig';
import { useBotsStore } from 'src/stores/bots/bots.store';
import { storeToRefs } from 'pinia';
import BotCard from 'src/components/bots/BotCard.vue';
import BotFormDialog from 'src/components/bots/BotFormDialog.vue';
import SpreadHistoryDialog from 'src/components/bots/SpreadHistoryDialog.vue';

const $q = useQuasar();
const botsStore = useBotsStore();
const { bots, loading } = storeToRefs(botsStore);

const isFormOpen = ref(false);
const editingBot = ref<BotConfig | null>(null);

const isHistoryOpen = ref(false);
const historyBot = ref<BotConfig | null>(null);

const loadBots = async () => {
  await botsStore.fetchBots();
};

const openCreateDialog = () => {
  editingBot.value = null;
  isFormOpen.value = true;
};

const openEditDialog = (bot: BotConfig) => {
  editingBot.value = bot;
  isFormOpen.value = true;
};

const openHistory = (bot: BotConfig) => {
  historyBot.value = bot;
  isHistoryOpen.value = true;
};

const toggleBot = async (bot: BotConfig) => {
  try {
    await botsStore.toggleBot(bot);
  } catch (e) {
    $q.notify({ color: 'negative', message: 'Ошибка обновления статуса' });
  }
};

const deleteBot = (id: number) => {
  $q.dialog({
    title: 'Удалить',
    message: 'Удалить карточку этого бота навсегда?',
    cancel: true,
    persistent: true,
    dark: true,
    color: 'negative'
  }).onOk(async () => {
    try {
      await botsStore.deleteBot(id);
    } catch (e) {
      $q.notify({ color: 'negative', message: 'Не удалось удалить бота' });
    }
  });
};

const forceCloseBot = (id: number) => {
  $q.dialog({
    title: 'Отмена сделок',
    message: 'Принудительно закрыть все открытые сделки этого бота по рынку прямо сейчас?',
    cancel: true,
    persistent: true,
    dark: true,
    color: 'warning'
  }).onOk(async () => {
    try {
      await botsStore.forceCloseBot(id);
      $q.notify({ color: 'positive', message: 'Команда на экстренное закрытие отправлена' });
    } catch (e) {
      $q.notify({ color: 'negative', message: 'Не удалось отправить команду на закрытие' });
    }
  });
};

onMounted(() => {
  loadBots();
});
</script>

<style lang="sass" scoped>
.bot-list-page
  /* Full screen layout */

.bot-cards-grid
  display: grid
  grid-template-columns: repeat(auto-fill, minmax(370px, 1fr))
  gap: 16px

.text-title-color
  color: $title-color !important

.text-text-color
  color: $text-color !important

.bg-surface
  background-color: rgba(255, 255, 255, 0.03)
  border: 1px dashed $blue-dark

.border-radius-sm
  border-radius: $generic-border-radius

.opacity-70
  opacity: 0.7
</style>
