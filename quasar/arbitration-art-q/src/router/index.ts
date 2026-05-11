import { defineRouter } from '#q-app/wrappers';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';
import routes from './routes';
import { useAuthStore } from 'stores/auth';

export default defineRouter(function (/* { store, ssrContext } */) {
  const createHistory = process.env.SERVER
    ? createMemoryHistory
    : (process.env.VUE_ROUTER_MODE === 'history' ? createWebHistory : createWebHashHistory);

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,
    history: createHistory(process.env.VUE_ROUTER_BASE),
  });

  Router.beforeEach(async (to) => {
    const authStore = useAuthStore();
    const hasAccessToken = !!authStore.accessToken || !!localStorage.getItem('access_token');

    // If we have a token on hand but the user object has not been hydrated
    // yet (e.g. cold app start after F5), fetch it before letting the route
    // resolve. This avoids the brief window where router thinks the user is
    // authenticated but components see `currentUser=null`.
    if (hasAccessToken && !authStore.currentUser) {
      try {
        await authStore.fetchUser();
      } catch {
        // axios interceptor will have cleared the session if refresh failed.
        // Fall through to the guard below which will redirect to /login.
      }
    }

    const isAuthenticated = !!authStore.currentUser;

    if (to.path !== '/login' && !isAuthenticated) {
      return '/login';
    }
    if (to.path === '/login' && isAuthenticated) {
      return '/';
    }
  });

  return Router;
});
