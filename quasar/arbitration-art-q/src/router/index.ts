import { defineRouter } from '#q-app/wrappers';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';
import routes from './routes';
import { useAuthStore, type SectionKey } from 'stores/auth';

// Gateable sections in menu order, with their landing path. Used to send a user
// away from a disabled section to the first one they can still reach.
const SECTION_PATH: Record<SectionKey, string> = {
  bots: '/',
  screener: '/screener',
  levels: '/levels',
  pnl: '/pnl',
};

// First section the user can access (menu order), or /profile — which has no
// section gate and is always available — when every gateable section is disabled.
function firstAllowedPath(auth: ReturnType<typeof useAuthStore>): string {
  for (const key of ['bots', 'screener', 'levels', 'pnl'] as SectionKey[]) {
    if (auth.canAccess(key)) return SECTION_PATH[key];
  }
  return '/profile';
}

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
      return firstAllowedPath(authStore);
    }

    // Section access gate (frontend-only): a disabled section is not navigable.
    // Send the user to the first section they can still reach (or profile, which
    // is always available). Routes without meta.section are never gated.
    if (isAuthenticated) {
      const section = to.meta.section as SectionKey | undefined;
      if (section && !authStore.canAccess(section)) {
        return firstAllowedPath(authStore);
      }
    }
  });

  return Router;
});
