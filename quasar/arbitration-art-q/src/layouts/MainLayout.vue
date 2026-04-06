<template>
  <q-layout view="hHh lpR fFf" class="main-layout">
    <q-header class="header bg-dark" flat>
      <q-toolbar class="full-height">
        <q-btn flat no-caps class="text-title-color text-weight-bold text-subtitle1 q-px-sm" to="/">
          Arbitration Art
        </q-btn>
        
        <q-space />

        <div class="row q-gutter-sm q-mr-md text-weight-medium">
          <q-btn flat no-caps label="Мои боты" to="/" />
          <q-btn flat no-caps label="Скринер" text-color="warning" to="/screener" />
        </div>

        <div v-if="authStore.currentUser" class="flex flex-center cursor-pointer q-pa-sm user-info" @click="goToProfile">
          <!-- User Avatar -->
          <q-avatar color="primary" text-color="white" size="sm" font-size="0.8rem" class="text-weight-bold">
            {{ userInitials }}
          </q-avatar>
          <span class="q-ml-sm text-text-color text-weight-medium">{{ authStore.currentUser.email }}</span>
        </div>
        <q-spinner v-else-if="loadingUser" color="primary" size="sm" class="q-mr-md" />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from 'stores/auth';

const router = useRouter();
const authStore = useAuthStore();
const loadingUser = ref(true);

const userInitials = computed(() => {
  const email = authStore.currentUser?.email;
  return email ? email.charAt(0).toUpperCase() : '';
});

const goToProfile = () => {
  router.push('/profile');
};

onMounted(async () => {
  if (!authStore.currentUser) {
    try {
      await authStore.fetchUser();
    } catch (e) {
      // If fetching fails, interceptors will likely handle 401 redirect
      console.warn('Failed to load user profile');
    }
  }
  loadingUser.value = false;
});
</script>

<style lang="sass" scoped>
.main-layout
  background-color: $dark-page !important

.header
  border-bottom: 1px solid $blue-dark
  height: 64px

.text-title-color
  color: $title-color !important

.text-text-color
  color: $text-color !important

.user-info
  border-radius: $generic-border-radius
  transition: background-color 0.2s ease
  &:hover
    background-color: rgba(255, 255, 255, 0.05)
</style>
