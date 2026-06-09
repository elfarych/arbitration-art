<template>
  <!-- Shared Telegram block (bot link + chat_id input). The chat_id is a single
       per-user value reused by both level and price notifications; the parent
       owns it (v-model) and persists it on its tab's Save. -->
  <div class="tg">
    <div class="row items-center no-wrap q-mb-sm">
      <div class="tg-icon">
        <q-icon name="send" size="15px" />
      </div>
      <span class="group-label q-ml-sm">Telegram</span>
      <q-space />
      <div class="tg-status" :class="connected ? 'tg-status--on' : 'tg-status--off'">
        <span class="tg-dot"></span>
        {{ connected ? 'подключено' : 'не указан' }}
      </div>
    </div>

    <div class="text-caption text-grey-6 q-mb-sm tg-hint">
      Откройте бота, нажмите <span class="text-grey-4 text-weight-medium">/start</span> — он
      пришлёт ваш <span class="text-grey-4 text-weight-medium">chat_id</span>, вставьте его ниже.
    </div>

    <q-btn
      :href="botUrl"
      target="_blank"
      rel="noopener noreferrer"
      type="a"
      icon="open_in_new"
      :label="botLabel"
      no-caps
      dense
      unelevated
      color="primary"
      size="sm"
      class="tg-bot-btn q-mb-sm"
    />

    <q-input
      :model-value="modelValue"
      label="Chat ID"
      dense
      outlined
      dark
      class="tg-input"
      @update:model-value="(value) => emit('update:modelValue', String(value ?? '').trim())"
    >
      <template #prepend>
        <q-icon name="badge" size="18px" color="grey-6" />
      </template>
    </q-input>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const connected = computed(() => props.modelValue.trim().length > 0);

// Telegram bot link — hardcoded to the notifications bot. Must stay the SAME bot
// whose token the level-notifier service uses (TELEGRAM_BOT_TOKEN), otherwise
// /start returns a chat_id that gets no alerts. Not read from env: process.env.*
// is not injected into the production bundle (see DOCS §28). botLabel (@username)
// is derived from the URL.
const botUrl = 'https://t.me/Brakeoutautobot';
const botMatch = botUrl.match(/t\.me\/([A-Za-z0-9_]+)/);
const botLabel = botMatch ? `@${botMatch[1]}` : 'Открыть бота';
</script>

<style lang="sass" scoped>
.group-label
  font-size: 11px
  letter-spacing: 0.6px
  text-transform: uppercase
  color: $grey-5
  font-weight: 700

.tg-icon
  display: flex
  align-items: center
  justify-content: center
  width: 24px
  height: 24px
  border-radius: 7px
  color: #4aa8e0
  background: rgba(74, 168, 224, 0.16)

.tg-status
  display: inline-flex
  align-items: center
  gap: 5px
  font-size: 10.5px
  font-weight: 600
  letter-spacing: 0.3px
  text-transform: uppercase
  padding: 2px 8px
  border-radius: 20px

.tg-status--on
  color: $positive
  background: rgba($positive, 0.12)

.tg-status--off
  color: $grey-6
  background: rgba(255, 255, 255, 0.05)

.tg-dot
  width: 6px
  height: 6px
  border-radius: 50%
  background: currentColor

.tg-status--on .tg-dot
  box-shadow: 0 0 0 3px rgba($positive, 0.18)

.tg-hint
  line-height: 1.45

.tg-bot-btn
  border-radius: 8px
</style>
