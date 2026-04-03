<template>
  <q-layout view="lHh Lpr lFf" class="bg-dark-page auth-layout">
    <q-page-container class="flex flex-center window-height">
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
// Minimalistic layout for the authentication screen
</script>

<style lang="sass" scoped>
.auth-layout
  background-color: $dark-page !important
</style>
