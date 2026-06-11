import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    component: () => import('layouts/AuthLayout.vue'),
    children: [
      { path: '', component: () => import('pages/auth/LoginPage.vue') }
    ]
  },
  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      // meta.section gates the route per-user (frontend gate, see router guard +
      // auth store canAccess). Routes without a section (profile, trader-runtime)
      // are always available. Keep section keys in sync with SectionKey / Django
      // UserSectionAccess (AGENTS.md §9).
      { path: '', component: () => import('pages/IndexPage.vue'), meta: { section: 'bots' } },
      { path: 'trader-runtime', component: () => import('pages/TraderRuntimePage.vue') },
      { path: 'profile', component: () => import('pages/ProfilePage.vue') },
      { path: 'screener', component: () => import('pages/ScreenerPage.vue'), meta: { section: 'screener' } },
      { path: 'levels', component: () => import('pages/LevelsScreenerPage.vue'), meta: { section: 'levels' } },
      { path: 'levels/:symbol', component: () => import('pages/LevelDetailPage.vue'), meta: { section: 'levels' } },
      { path: 'pnl', component: () => import('pages/PnlPage.vue'), meta: { section: 'pnl' } }
    ],
  },
  {
    path: '/:catchAll(.*)*',
    component: () => import('pages/ErrorNotFound.vue'),
  },
];

export default routes;
