<template>
  <q-page class="flex flex-center full-width">
    <q-card class="auth-card q-pa-lg text-center bg-dark" flat bordered>
      <q-card-section>
        <div class="text-h5 text-title-color q-mb-sm text-weight-bold">Arbitration Art</div>
        <div class="text-subtitle2 text-text-color q-mb-md">Войдите в систему</div>
      </q-card-section>

      <q-card-section>
        <q-form @submit.prevent="onSubmit" class="q-gutter-md">
          <q-input
            v-model="email"
            type="email"
            label="Email"
            outlined
            dense
            dark
            color="primary"
            class="text-body-font"
            :rules="[val => !!val || 'Обязательное поле', val => /.+@.+\..+/.test(val) || 'Некорректный email']"
            lazy-rules
          />
          <q-input
            v-model="password"
            type="password"
            label="Пароль"
            outlined
            dense
            dark
            color="primary"
            class="text-body-font"
            :rules="[val => !!val || 'Обязательное поле', val => val.length >= 6 || 'Минимум 6 символов']"
            lazy-rules
          />

          <div v-if="errorMessage" class="text-negative text-left text-small q-mt-sm">
            {{ errorMessage }}
          </div>

          <div class="q-mt-lg">
            <q-btn
              type="submit"
              color="primary"
              :loading="loading"
              label="Войти"
              class="full-width text-weight-bold"
              size="md"
              unelevated
              no-caps
            />
          </div>
        </q-form>
      </q-card-section>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from 'stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const email = ref('');
const password = ref('');
const loading = ref(false);
const errorMessage = ref('');

const onSubmit = async () => {
  loading.value = true;
  errorMessage.value = '';
  
  try {
    await authStore.login(email.value, password.value);
    router.push('/');
  } catch (error: any) {
    if (error.response?.data?.detail) {
      errorMessage.value = error.response.data.detail;
    } else {
      errorMessage.value = 'Неверный email или пароль';
    }
  } finally {
    loading.value = false;
  }
};
</script>

<style lang="sass" scoped>
.auth-card
  width: 100%
  max-width: 400px
  border-radius: $generic-border-radius
  border-color: $blue-dark

.text-title-color
  color: $title-color !important

.text-text-color
  color: $text-color !important

.text-body-font
  font-size: $body-font-size

.text-small
  font-size: $small-font-size
</style>
