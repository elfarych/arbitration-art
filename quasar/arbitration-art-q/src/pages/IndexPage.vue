<template>
  <q-page padding class="bot-list-page max-width">
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

    <div v-else class="row q-col-gutter-md">
      <div v-for="bot in bots" :key="bot.id" class="col-12 col-md-6 col-lg-4">
        <BotCard 
          :bot="bot" 
          @toggle="toggleBot" 
          @edit="openEditDialog" 
          @delete="deleteBot" 
          @history="openHistory" 
        />
      </div>
    </div>

    <!-- Modals to be implemented next -->
    <BotFormDialog 
      v-model="isFormOpen" 
      :bot="editingBot" 
      @saved="loadBots" 
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
import { botConfigApi, type BotConfig } from 'src/services/api/botConfig';
import BotCard from 'src/components/bots/BotCard.vue';
import BotFormDialog from 'src/components/bots/BotFormDialog.vue';
import SpreadHistoryDialog from 'src/components/bots/SpreadHistoryDialog.vue';

const $q = useQuasar();
const bots = ref<BotConfig[]>([]);
const loading = ref(true);

const isFormOpen = ref(false);
const editingBot = ref<BotConfig | null>(null);

const isHistoryOpen = ref(false);
const historyBot = ref<BotConfig | null>(null);

const loadBots = async () => {
  loading.value = true;
  try {
    bots.value = await botConfigApi.list();
  } catch (e) {
    console.error('Failed to load bots', e);
  } finally {
    loading.value = false;
  }
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
  const previousState = bot.is_active;
  bot.is_active = !previousState;
  
  try {
    await botConfigApi.update(bot.id, { is_active: !previousState });
  } catch (e) {
    bot.is_active = previousState;
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
      await botConfigApi.delete(id);
      await loadBots();
    } catch (e) {
      $q.notify({ color: 'negative', message: 'Не удалось удалить бота' });
    }
  });
};

onMounted(() => {
  loadBots();
});
</script>

<style lang="sass" scoped>
.bot-list-page
  max-width: 1200px
  margin: 0 auto

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
